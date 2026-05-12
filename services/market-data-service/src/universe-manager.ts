// UniverseManager — builds and maintains the tradeable universe per Section 29.
// Applies eligibility filters (Section 29b) and sector-balance cap (Section 29c).
// All additions/removals are logged to instrument_registry for point-in-time reconstruction.

import { getMongoDb } from '@trader/shared-mongo';
import { COLLECTIONS } from '@trader/shared-mongo';
import { fetchT212Instruments } from './t212-client.ts';

const MAX_UNIVERSE_SIZE   = parseInt(process.env.UNIVERSE_MAX_SIZE   ?? '150');
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
    try {
      const raw = await fetchT212Instruments();
      instruments = raw.map((i) => ({
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

    // ── 2. Fetch OHLCV stats for Section 29b eligibility filters ──────────────
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

    // ── 3. Apply eligibility filters (Section 29b) ─────────────────────────────
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

    // ── 4. Sector-balance cap (Section 29c) ────────────────────────────────────
    // 'Unknown' is exempt: T212 instruments API provides no sector data, so all instruments
    // fall into 'Unknown' until enriched. Capping Unknown would silently truncate the universe.
    const sectorCap = Math.floor(MAX_UNIVERSE_SIZE * MAX_SECTOR_FRACTION);
    const sectorCount: Record<string, number> = {};
    const selected: InstrumentMeta[] = [];

    for (const inst of eligible) {
      if (selected.length >= MAX_UNIVERSE_SIZE) break;
      const sector = inst.sector;
      if (sector !== 'Unknown' && (sectorCount[sector] ?? 0) >= sectorCap) continue;
      selected.push(inst);
      sectorCount[sector] = (sectorCount[sector] ?? 0) + 1;
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
        await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY).insertMany(
          toInsert.map((i) => ({
            ticker:      i.ticker,
            name:        i.name,
            sector:      i.sector,
            activeFrom:  now,
            activeTo:    null,
            addedReason: 'universe_refresh',
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
