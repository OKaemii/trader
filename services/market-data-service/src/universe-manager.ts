// UniverseManager — builds and maintains the tradeable universe per Section 29.
// Applies eligibility filters (Section 29b) and sector-balance cap (Section 29c).
// All additions/removals are logged to instrument_registry for point-in-time reconstruction.

import { getMongoDb } from '@trader/shared-mongo';
import { COLLECTIONS } from '@trader/shared-mongo';
import { fetchT212Instruments } from './t212-client.ts';
import { fetchYahooLiquidity } from './yahoo-client.ts';

const MAX_UNIVERSE_SIZE   = parseInt(process.env.UNIVERSE_MAX_SIZE   ?? '150');
const INCLUDE_US          = (process.env.UNIVERSE_INCLUDE_US  ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const INCLUDE_LSE         = (process.env.UNIVERSE_INCLUDE_LSE ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const MIN_PRICE_GBP       = parseFloat(process.env.UNIVERSE_MIN_PRICE ?? '1.0');
// Section 29b: ADV ≥ £2M (20-day trailing). Applied only when T212 provides real volume data.
// Current T212 integration sets volume=0 — filter is a no-op until a real feed is wired.
// Spread (≤ 30bps) cannot be filtered here: T212 API does not expose bid-ask spread.
const MIN_ADV_GBP         = parseFloat(process.env.UNIVERSE_MIN_ADV ?? String(2_000_000));
const ADV_LOOKBACK_DAYS   = 20;
const MAX_SECTOR_FRACTION = 0.35;  // Section 29c: no more than 35% from one GICS sector

export interface InstrumentMeta {
  ticker:       string;
  name:         string;
  sector:       string;   // GICS sector (or 'Unknown' if T212 doesn't supply it)
  t212Tradable: boolean;
  market?:      'US' | 'LSE' | 'OTHER';
  adv?:         number;   // 5-day average dollar volume from Yahoo (curated path only)
}

/**
 * Apply portal-driven adds/removes on top of the eligibility-filtered selection.
 * Removes win over T212 inclusion; adds bypass the sector cap and are marked
 * t212Tradable=false so downstream code can detect operator-forced entries.
 * Exported for unit testing.
 */
export function applyUniverseOverrides(
  selected: InstrumentMeta[],
  overrides: { adds?: string[]; removes?: string[] } | null,
): { result: InstrumentMeta[]; added: number; removed: number } {
  if (!overrides) return { result: selected, added: 0, removed: 0 };

  const removeSet = new Set((overrides.removes ?? []).map((t) => t.toUpperCase().trim()).filter(Boolean));
  const before = selected.length;
  let result = selected.filter((i) => !removeSet.has(i.ticker.toUpperCase()));
  const removed = before - result.length;

  const presentTickers = new Set(result.map((i) => i.ticker.toUpperCase()));
  let added = 0;
  for (const rawTicker of overrides.adds ?? []) {
    const ticker = rawTicker.toUpperCase().trim();
    if (!ticker || presentTickers.has(ticker)) continue;
    result.push({ ticker, name: ticker, sector: 'Unknown', t212Tradable: false });
    presentTickers.add(ticker);
    added++;
  }
  return { result, added, removed };
}

/**
 * Resolve each include-list symbol to the best T212 instrument and rank by Yahoo ADV.
 *
 * Resolution rules:
 *  - US list → prefer `_US_EQ` suffix (NYSE/NASDAQ primary).
 *  - LSE list → prefer `l_EQ` with GBP/GBX currency (London primary).
 *  - Match on T212 `shortName` (bare symbol). Symbols T212 doesn't carry are silently
 *    skipped; count logged.
 *
 * Dedup: collapse multiple include-list entries that resolve to the same underlying
 * (same shortName), keeping the higher-ranked candidate. This guards against future
 * dual-listing additions (e.g. SHEL appearing in both lists).
 *
 * Returns at most MAX_UNIVERSE_SIZE entries, ranked by 5-day average dollar volume
 * descending, with the sector cap applied (currently a no-op since T212 returns
 * sector='Unknown' for every instrument).
 */
async function selectCurated(
  rawInstruments: Awaited<ReturnType<typeof fetchT212Instruments>>,
): Promise<InstrumentMeta[]> {
  // Build a shortName-indexed lookup, choosing the best T212 ticker per (symbol, market).
  // T212 lists multiple cross-listings per symbol (e.g. VFEM has VFEMl_EQ, VFEMs_EQ, VFEMa_EQ);
  // we score per-market and keep the top scorer.
  const byMarket: Record<'US' | 'LSE', Record<string, typeof rawInstruments[number]>> = {
    US:  {},
    LSE: {},
  };

  for (const inst of rawInstruments) {
    const sn = inst.shortName?.toUpperCase();
    if (!sn) continue;

    const isUS  = /_US_EQ$/.test(inst.ticker);
    const isLSE = /l_EQ$/.test(inst.ticker) &&
                  (inst.currencyCode === 'GBP' || inst.currencyCode === 'GBX');

    if (isUS && !byMarket.US[sn]) byMarket.US[sn] = inst;
    if (isLSE && !byMarket.LSE[sn]) byMarket.LSE[sn] = inst;
  }

  const candidates: InstrumentMeta[] = [];
  const seenShortNames = new Set<string>();
  let unresolvedUS = 0;
  let unresolvedLSE = 0;

  for (const sym of INCLUDE_US) {
    const m = byMarket.US[sym];
    if (!m) { unresolvedUS++; continue; }
    if (seenShortNames.has(sym)) continue;
    seenShortNames.add(sym);
    candidates.push({
      ticker:       m.ticker,
      name:         m.name,
      sector:       m.sector ?? 'Unknown',
      t212Tradable: true,
      market:       'US',
    });
  }
  for (const sym of INCLUDE_LSE) {
    const m = byMarket.LSE[sym];
    if (!m) { unresolvedLSE++; continue; }
    if (seenShortNames.has(sym)) {
      console.warn(`[universe] cross-listing dedup: ${sym} already in US pool, skipping LSE ${m.ticker}`);
      continue;
    }
    seenShortNames.add(sym);
    candidates.push({
      ticker:       m.ticker,
      name:         m.name,
      sector:       m.sector ?? 'Unknown',
      t212Tradable: true,
      market:       'LSE',
    });
  }

  if (unresolvedUS || unresolvedLSE) {
    console.warn(`[universe] include-list unresolved: US=${unresolvedUS} LSE=${unresolvedLSE} (T212 has no matching instrument)`);
  }
  console.log(`[universe] curated candidates: ${candidates.length} (US: ${INCLUDE_US.length - unresolvedUS}, LSE: ${INCLUDE_LSE.length - unresolvedLSE})`);

  // Yahoo liquidity rank. Candidates that fail Yahoo resolution get ADV=0 and rank last.
  const advMap = await fetchYahooLiquidity(candidates.map((c) => c.ticker));
  for (const c of candidates) c.adv = advMap[c.ticker] ?? 0;
  candidates.sort((a, b) => (b.adv ?? 0) - (a.adv ?? 0));

  // Sector cap (currently inert until sector enrichment lands, but kept symmetric with
  // the legacy path so an upgrade to real GICS sectors works without touching this code).
  const sectorCap = Math.floor(MAX_UNIVERSE_SIZE * MAX_SECTOR_FRACTION);
  const sectorCount: Record<string, number> = {};
  const selected: InstrumentMeta[] = [];

  for (const inst of candidates) {
    if (selected.length >= MAX_UNIVERSE_SIZE) break;
    const sector = inst.sector;
    if (sector !== 'Unknown' && (sectorCount[sector] ?? 0) >= sectorCap) continue;
    selected.push(inst);
    sectorCount[sector] = (sectorCount[sector] ?? 0) + 1;
  }
  return selected;
}

export class UniverseManager {
  private _activeUniverse: string[] = [];
  private _sectorMap: Record<string, string> = {};

  /** Call once at startup, then monthly. */
  async refresh(): Promise<string[]> {
    const db = await getMongoDb();
    const now = new Date();

    // ── 1. Fetch all T212 instruments ──────────────────────────────────────────
    let instruments: InstrumentMeta[] = [];
    let rawInstruments: Awaited<ReturnType<typeof fetchT212Instruments>> = [];
    try {
      rawInstruments = await fetchT212Instruments();
      instruments = rawInstruments.map((i) => ({
        ticker:       i.ticker,
        name:         i.name,
        sector:       i.sector ?? 'Unknown',
        t212Tradable: true,
      }));
    } catch (err) {
      console.warn('[universe] T212 instrument fetch failed, using existing registry:', err);
      // Fall back to whatever is already in the registry
      const existing = await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY)
        .find({ activeTo: null })
        .toArray();
      this._activeUniverse = existing.map((d: any) => d.ticker);
      this._sectorMap      = Object.fromEntries(existing.map((d: any) => [d.ticker, d.sector ?? 'Unknown']));
      return this._activeUniverse;
    }

    let selected: InstrumentMeta[];

    if (INCLUDE_US.length > 0 || INCLUDE_LSE.length > 0) {
      // ── 2/3/4 (curated): resolve include lists → ADV rank → top N ────────────
      // Each include-list symbol is matched against T212's `shortName` (the bare symbol,
      // e.g. "AAPL", "SHEL") and the best T212 ticker is picked per the market preference:
      // US list prefers `_US_EQ`, LSE list prefers GBP/GBX `l_EQ`. Unresolved symbols are
      // dropped — the log line reports how many. Liquidity comes from a one-shot Yahoo call
      // per candidate; ranking ensures stable selection across refreshes when the candidate
      // pool exceeds MAX_UNIVERSE_SIZE.
      selected = await selectCurated(rawInstruments);
    } else {
      // ── 2. Fetch OHLCV stats for Section 29b eligibility filters ─────────────
      const allTickers = instruments.map((i) => i.ticker);
      const lookbackDate = new Date(now.getTime() - ADV_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

      // Aggregate 20-day ADV and latest close per ticker from stored OHLCV bars.
      // volume=0 from the T212 fill-price approximation means ADV filter is
      // currently a pass-through; it activates automatically once real volume data flows.
      const ohlcvStats = await db.collection(COLLECTIONS.OHLCV_BARS).aggregate([
        { $match: { ticker: { $in: allTickers }, timestamp: { $gte: lookbackDate } } },
        { $sort: { timestamp: 1 } },
        { $group: {
          _id: '$ticker',
          avgVolume:   { $avg: '$volume' },
          latestClose: { $last: '$close' },
        }},
      ]).toArray();

      const statsMap: Record<string, { avgVolume: number; latestClose: number }> = {};
      for (const s of ohlcvStats) {
        statsMap[s._id as string] = { avgVolume: s.avgVolume as number ?? 0, latestClose: s.latestClose as number ?? 0 };
      }

      // ── 3. Apply eligibility filters (Section 29b) ───────────────────────────
      // Spread filter (≤ 30bps): T212 API does not expose bid-ask spread — cannot implement.
      const eligible = instruments.filter((i) => {
        if (!i.t212Tradable) return false;

        const stats = statsMap[i.ticker];
        if (!stats) return true;  // No OHLCV history yet (bootstrapping) — allow through

        // Price filter (Section 29b: ≥ £1)
        if (stats.latestClose > 0 && stats.latestClose < MIN_PRICE_GBP) return false;

        // ADV filter (Section 29b: ≥ £2M). No-op when volume=0 (T212 limitation).
        if (stats.avgVolume > 0) {
          const adv = stats.avgVolume * stats.latestClose;
          if (adv < MIN_ADV_GBP) return false;
        }

        return true;
      });

      // ── 4. Sector-balance cap (Section 29c) ──────────────────────────────────
      // 'Unknown' is exempt: T212 instruments API provides no sector data, so all instruments
      // fall into 'Unknown' until enriched. Capping Unknown would silently truncate the universe.
      const sectorCap = Math.floor(MAX_UNIVERSE_SIZE * MAX_SECTOR_FRACTION);
      const sectorCount: Record<string, number> = {};
      selected = [];

      for (const inst of eligible) {
        if (selected.length >= MAX_UNIVERSE_SIZE) break;
        const sector = inst.sector;
        if (sector !== 'Unknown' && (sectorCount[sector] ?? 0) >= sectorCap) continue;
        selected.push(inst);
        sectorCount[sector] = (sectorCount[sector] ?? 0) + 1;
      }
    }

    // ── 4b. Portal overrides — applied AFTER eligibility/sector filtering ─────
    // Reason: forced adds/removes are an operator decision and must take precedence over
    // the criteria-driven selection. Removes win over T212 inclusion; adds bypass sector cap.
    const overridesDoc = await db.collection<{
      _id: 'singleton';
      adds: string[];
      removes: string[];
    }>(COLLECTIONS.PORTAL_UNIVERSE_OVERRIDES).findOne({ _id: 'singleton' });

    const overrideResult = applyUniverseOverrides(selected, overridesDoc);
    selected = overrideResult.result;
    if (overrideResult.added || overrideResult.removed) {
      console.log(`[universe] overrides applied: +${overrideResult.added} -${overrideResult.removed}`);
    }

    const newTickers = new Set(selected.map((i) => i.ticker));

    // ── 5. Diff against current registry — log additions and removals ──────────
    const currentDocs = await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY)
      .find({ activeTo: null })
      .toArray();
    const currentTickers = new Set(currentDocs.map((d: any) => d.ticker));

    // Additions — split into true new inserts vs reactivations of previously-removed tickers.
    // insertMany would collide with the unique_ticker index if a doc exists with activeTo set.
    const added = selected.filter((i) => !currentTickers.has(i.ticker));
    if (added.length > 0) {
      const addedTickers = added.map((i) => i.ticker);
      const existingDocs = await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY)
        .find({ ticker: { $in: addedTickers } })
        .toArray();
      const existingSet = new Set(existingDocs.map((d: any) => d.ticker));

      const toInsert     = added.filter((i) => !existingSet.has(i.ticker));
      const toReactivate = added.filter((i) =>  existingSet.has(i.ticker));

      if (toInsert.length > 0) {
        const overrideAdds = new Set(
          (overridesDoc?.adds ?? []).map((t) => t.toUpperCase().trim()),
        );
        await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY).insertMany(
          toInsert.map((i) => ({
            ticker:      i.ticker,
            name:        i.name,
            sector:      i.sector,
            market:      i.market ?? 'OTHER',
            adv:         i.adv ?? 0,
            activeFrom:  now,
            activeTo:    null,
            addedReason: overrideAdds.has(i.ticker.toUpperCase()) ? 'override_add' : 'universe_refresh',
            updatedAt:   now,
          })),
        );
      }
      if (toReactivate.length > 0) {
        await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY).updateMany(
          { ticker: { $in: toReactivate.map((i) => i.ticker) } },
          { $set: { activeTo: null, addedReason: 'universe_reactivation', updatedAt: now } },
        );
      }
      console.log(`[universe] added ${added.length} instruments: ${added.map((i) => i.ticker).join(', ')}`);
    }

    // Refresh ADV + market on every surviving entry so the portal table doesn't show
    // stale liquidity. Skip when fields are undefined (legacy path) so we don't blow
    // away a known value with an empty one.
    const refreshUpdates = selected.filter((i) => i.adv != null || i.market != null);
    for (const i of refreshUpdates) {
      await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY).updateOne(
        { ticker: i.ticker, activeTo: null },
        { $set: {
          ...(i.market != null ? { market: i.market } : {}),
          ...(i.adv != null    ? { adv: i.adv }       : {}),
          updatedAt: now,
        }},
      );
    }

    // Removals (5-day grace period is tracked externally; we hard-remove here for v1)
    const removed = currentDocs.filter((d: any) => !newTickers.has(d.ticker));
    if (removed.length > 0) {
      await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY).updateMany(
        { ticker: { $in: removed.map((d: any) => d.ticker) }, activeTo: null },
        { $set: { activeTo: now, removedReason: 'universe_refresh', updatedAt: now } },
      );
      console.log(`[universe] removed ${removed.length} instruments: ${removed.map((d: any) => d.ticker).join(', ')}`);
    }

    this._activeUniverse = selected.map((i) => i.ticker);
    this._sectorMap      = Object.fromEntries(selected.map((i) => [i.ticker, i.sector]));

    console.log(`[universe] active universe: ${this._activeUniverse.length} instruments`);
    return this._activeUniverse;
  }

  /** Returns the current in-memory active universe. Call refresh() first. */
  get activeTickers(): string[] {
    return this._activeUniverse;
  }

  get sectorMap(): Record<string, string> {
    return this._sectorMap;
  }

  /** Reconstruct the universe active at a given point in time (for backtesting). */
  static async getActiveAt(timestampMs: number): Promise<string[]> {
    const db = await getMongoDb();
    const ts = new Date(timestampMs);
    const docs = await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY)
      .find({
        activeFrom: { $lte: ts },
        $or: [{ activeTo: null }, { activeTo: { $gte: ts } }],
      })
      .toArray();
    return docs.map((d: any) => d.ticker);
  }
}
