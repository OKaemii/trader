// UniverseManager — builds and maintains the tradeable universe per Section 29.
// Applies eligibility filters (Section 29b) and sector-balance cap (Section 29c).
// All additions/removals are logged to instrument_registry for point-in-time reconstruction.

import { getMongoDb } from '@trader/shared-mongo';
import { COLLECTIONS } from '@trader/shared-mongo';
import { getPgPool } from '@trader/shared-pg';
import { Trading212TickerAdapter, type TickerIdentity } from '@trader/ticker-identity';
import type { Currency } from '@trader/shared-types';
import { tryIdentityOf, tickerOf } from '../../../shared/identity.ts';
import { fetchT212Instruments } from '../infrastructure/t212-client.ts';
import { fetchYahooLiquidity } from '../../bars/infrastructure/providers/yahoo-client.ts';
import { MongoInstrumentMeta } from '../infrastructure/MongoInstrumentMeta.ts';
import { YahooSectorClient } from '../infrastructure/yahoo-sector-client.ts';
import { fetchEodhdCapScan } from '../infrastructure/eodhd-scan.ts';
import { mapEodhdToT212 } from '../infrastructure/eodhd-symbol-map.ts';
import { log } from '../../../logger.ts';

// Rows older than this are re-fetched from Yahoo on the next refresh. Sectors are
// stable for months so a long stale window is fine; the lower bound keeps us
// covered for the rare GICS reclassification (~quarterly) and lets the operator
// drop the env to force a re-pull.
const SECTOR_STALE_MS_DEFAULT = 30 * 24 * 60 * 60 * 1000;   // 30 days

// FX converter callback; same shape as the one we pass to YahooProvider. Provided by
// the bootstrap (index.ts) so the manager stays independent of @trader/shared-fx.
export type FxToGBP = (amount: number, currency: Currency) => Promise<number>;
// Identity converter — used when no FX is wired (tests, legacy fallback). Liquidity
// ranks within a single currency stay correct; cross-currency comparisons under this
// path are off by an FX factor.
const IDENTITY_FX: FxToGBP = async (amount) => amount;

export interface UniverseConfig {
  maxSize:    number;
  includeUs:  string[];
  includeLse: string[];
  minPriceGbp: number;
  // Section 29b: ADV ≥ £2M (20-day trailing). Applied only when T212 provides real volume data.
  // Current T212 integration sets volume=0 — filter is a no-op until a real feed is wired.
  // Spread (≤ 30bps) cannot be filtered here: T212 API does not expose bid-ask spread.
  minAdvGbp: number;
  // Candidate source: 'curated' (UNIVERSE_INCLUDE_* lists) or 'eodhd_scan' (EODHD market-cap
  // screener >= minCapGbp). Either way the result is the ONE active universe (instrument_registry).
  source: 'curated' | 'eodhd_scan';
  // Market-cap floor (GBP) for the eodhd_scan source.
  minCapGbp: number;
}

const DEFAULT_CONFIG: UniverseConfig = {
  maxSize:    150,
  includeUs:  [],
  includeLse: [],
  minPriceGbp: 1.0,
  minAdvGbp: 2_000_000,
  source:     'curated',
  minCapGbp:  5_000_000_000,
};

const ADV_LOOKBACK_DAYS   = 20;
const MAX_SECTOR_FRACTION = 0.35;  // Section 29c: no more than 35% from one GICS sector
const MAX_SPREAD_BPS = 30;          // Section 29b: exclude tickers with trailing-7d median spread > 30bps
const SPREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Trailing-7d median quoted spread (bps) per ticker, from REAL (non-synthetic) REGULAR-session
// quotes only. Tickers with no real quote history → absent from the map → pass-through (the
// filter is inactive until ≥1 real REGULAR quote exists, e.g. the first 7 days post-deploy, or
// for synthetic-only LSE small-caps where the high-low proxy would unfairly exclude them).
const spreadTickerAdapter = new Trading212TickerAdapter();

async function medianSpreadByTicker(tickers: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tickers.length === 0) return out;
  try {
    const pool = getPgPool();
    // quotes is keyed on the bare identity (symbol, market). Split each ticker, query the (symbol,
    // market) membership, and re-key the grouped result back to the caller's T212 ticker.
    const ids = tickers.map((t) => ({ ticker: t, ...spreadTickerAdapter.fromT212(t) }));
    const symbols = ids.map((i) => i.symbol);
    const markets = ids.map((i) => i.market);
    const tickerByIdentity = new Map(ids.map((i) => [`${i.symbol}|${i.market}`, i.ticker]));
    const { rows } = await pool.query<{ symbol: string; market: string; median_bps: number }>(
      `SELECT symbol, market, percentile_cont(0.5) WITHIN GROUP (ORDER BY spread_bps) AS median_bps
       FROM quotes
       WHERE (symbol, market) IN (SELECT unnest($1::text[]), unnest($2::text[]))
         AND is_superseded = FALSE AND is_synthetic = FALSE
         AND market_state = 'REGULAR' AND spread_bps IS NOT NULL
         AND observation_ts >= $3
       GROUP BY symbol, market`,
      [symbols, markets, Date.now() - SPREAD_WINDOW_MS],
    );
    for (const r of rows) {
      const t = tickerByIdentity.get(`${r.symbol}|${r.market}`);
      if (t !== undefined) out.set(t, Number(r.median_bps));
    }
  } catch (err) {
    log.warn('[universe] spread-filter query failed — filter inactive this refresh:', err);
  }
  return out;
}

// Yahoo enrichment is best-effort. Cap each call so a rate-limited (429-walled) or hung
// upstream can never stall refresh() — and thus can never block the poll loop from
// starting. (2026-05 incident: refresh() hung on Yahoo's 429 wall during ADV ranking, so
// market:raw went stale for ~3 days while the poll loop never started.)
const ADV_RANK_TIMEOUT_MS     = 25_000;
const SECTOR_FETCH_TIMEOUT_MS = 25_000;

// Race a promise against a timeout; on timeout OR rejection, resolve to `fallback`. The
// universe is still built from the T212-resolved candidates, just without this enhancement
// (unranked ADV / stale sectors), which the poll loop tolerates fine.
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      log.warn(`[universe] ${label} exceeded ${Math.round(ms / 1000)}s — proceeding without it (Yahoo rate-limit/hang)`);
      resolve(fallback);
    }, ms);
  });
  const guarded = p.catch((err) => {
    log.warn(`[universe] ${label} failed — proceeding without it:`, err);
    return fallback;
  });
  try {
    return await Promise.race([guarded, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface InstrumentMeta {
  ticker:       string;
  name:         string;
  sector:       string;   // GICS sector (or 'Unknown' if T212 doesn't supply it)
  t212Tradable: boolean;
  market?:      'US' | 'LSE' | 'OTHER';
  adv?:         number;   // 5-day average dollar volume from Yahoo (curated path only)
}

/** A forced add/remove entry as stored in portal_universe_overrides since Task 16b — the bare
 *  (symbol, market) identity, never the concatenated T212 ticker. */
export interface OverrideEntry { symbol: string; market: string }

/** The portal_universe_overrides singleton document shape (Task 16b: bare-identity adds/removes). */
export interface OverridesDoc {
  _id: 'singleton';
  adds: OverrideEntry[];
  removes: OverrideEntry[];
  updatedBy?: string;
  updatedAt?: Date;
}

/**
 * Re-derive the T212 ticker per stored override entry, dropping any whose (symbol, market) can't be
 * re-joined to a US/LSE form (fail-soft — never throw the refresh). Used at the Mongo read boundary
 * so the T212-keyed override-application logic stays behaviour-identical (the bare-forced-add UX is
 * Task 18/21).
 */
export function identitiesToTickers(entries: OverrideEntry[] | undefined): string[] {
  const out: string[] = [];
  for (const e of entries ?? []) {
    if (!e || typeof e.symbol !== 'string' || typeof e.market !== 'string') continue;
    try { out.push(tickerOf(e.symbol, e.market)); } catch { /* un-routable identity — skip */ }
  }
  return out;
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

  // Case-sensitive matching. T212 tickers carry meaningful case in the exchange suffix
  // (`SGLNl_EQ` is a London listing; `SGLNL_EQ` would be wrong). Earlier code upper-cased
  // both sides, which silently mangled overrides like `SGLNl_EQ` into `SGLNL_EQ` and then
  // failed to match against the T212 catalog.
  const removeSet = new Set((overrides.removes ?? []).map((t) => t.trim()).filter(Boolean));
  const before = selected.length;
  let result = selected.filter((i) => !removeSet.has(i.ticker));
  const removed = before - result.length;

  const presentTickers = new Set(result.map((i) => i.ticker));
  let added = 0;
  for (const rawTicker of overrides.adds ?? []) {
    const ticker = rawTicker.trim();
    if (!ticker || presentTickers.has(ticker)) continue;
    // Infer market from T212 suffix so the portal renders the right badge and so the
    // value persists onto instrument_registry. Without this, override-added entries fall
    // through to 'OTHER' in the upsert and the universe overview shows "—" for the region.
    const market: 'US' | 'LSE' | 'OTHER' =
      /_US_EQ$/.test(ticker) ? 'US' :
      /l_EQ$/.test(ticker)   ? 'LSE' : 'OTHER';
    result.push({ ticker, name: ticker, sector: 'Unknown', t212Tradable: false, market });
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
 * Returns at most this.config.maxSize entries, ranked by 5-day average dollar volume
 * descending, with the sector cap applied (currently a no-op since T212 returns
 * sector='Unknown' for every instrument).
 */
async function selectCurated(
  rawInstruments: Awaited<ReturnType<typeof fetchT212Instruments>>,
  fxToGBP: FxToGBP,
  config: UniverseConfig,
): Promise<InstrumentMeta[]> {
  const includeUs  = config.includeUs;
  const includeLse = config.includeLse;
  const maxSize    = config.maxSize;
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

  for (const sym of includeUs) {
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
  for (const sym of includeLse) {
    const m = byMarket.LSE[sym];
    if (!m) { unresolvedLSE++; continue; }
    if (seenShortNames.has(sym)) {
      log.warn(`[universe] cross-listing dedup: ${sym} already in US pool, skipping LSE ${m.ticker}`);
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
    log.warn(`[universe] include-list unresolved: US=${unresolvedUS} LSE=${unresolvedLSE} (T212 has no matching instrument)`);
  }
  log.info(`[universe] curated candidates: ${candidates.length} (US: ${includeUs.length - unresolvedUS}, LSE: ${includeLse.length - unresolvedLSE})`);

  // Yahoo liquidity rank. ADV values are normalised to GBP (the base currency) so a
  // USD-denominated $1M ADV and a GBP-denominated £1M ADV are no longer treated as
  // equal-sized — fxToGBP applies the live rate before ranking.
  const advMap = await withTimeout(
    fetchYahooLiquidity(candidates.map((c) => c.ticker), fxToGBP),
    ADV_RANK_TIMEOUT_MS, {}, 'ADV liquidity ranking',
  );
  for (const c of candidates) c.adv = advMap[c.ticker] ?? 0;
  candidates.sort((a, b) => (b.adv ?? 0) - (a.adv ?? 0));

  // Sector cap (currently inert until sector enrichment lands, but kept symmetric with
  // the legacy path so an upgrade to real GICS sectors works without touching this code).
  const sectorCap = Math.floor(maxSize * MAX_SECTOR_FRACTION);
  const sectorCount: Record<string, number> = {};
  const selected: InstrumentMeta[] = [];

  for (const inst of candidates) {
    if (selected.length >= maxSize) break;
    const sector = inst.sector;
    if (sector !== 'Unknown' && (sectorCount[sector] ?? 0) >= sectorCap) continue;
    selected.push(inst);
    sectorCount[sector] = (sectorCount[sector] ?? 0) + 1;
  }
  return selected;
}

/**
 * Balance an eodhd_scan selection evenly across US and LSE. A naive global market-cap sort yields
 * a ~95% US universe (US caps dwarf UK — even the smallest S&P name outweighs most of the FTSE),
 * which defeats the point of holding a UK book. We instead target `maxSize/2` names per market by
 * descending cap, then backfill the deficit from whichever market has names to spare when the
 * other is short of its half (e.g. fewer than `maxSize/2` UK names clear the £5B floor). The
 * result is capped at `maxSize`, US-block first then LSE-block. Pure + exported for unit testing.
 */
export function balanceByMarket<T extends { market: 'US' | 'LSE'; marketCapGbp: number }>(
  items: T[],
  maxSize: number,
): T[] {
  if (maxSize <= 0) return [];
  const byCap = (a: T, b: T) => b.marketCapGbp - a.marketCapGbp;
  const us  = items.filter((i) => i.market === 'US').sort(byCap);
  const lse = items.filter((i) => i.market === 'LSE').sort(byCap);
  const perMarket = Math.floor(maxSize / 2);
  const usPick  = us.slice(0, perMarket);
  const lsePick = lse.slice(0, perMarket);
  const result = [...usPick, ...lsePick];
  if (result.length < maxSize) {
    // One market was short of its half — backfill from the other market's overflow, highest cap first.
    const overflow = [...us.slice(usPick.length), ...lse.slice(lsePick.length)].sort(byCap);
    result.push(...overflow.slice(0, maxSize - result.length));
  }
  return result;
}

/**
 * EODHD-scan universe source. Scans every US+LSE name >= minCapGbp via the EODHD screener,
 * maps to tradeable T212 tickers, dedupes by ticker, and selects a market-balanced top set
 * (100 US / 100 LSE at maxSize=200, via balanceByMarket — market cap is a sound liquidity proxy
 * at the >=£5B floor, avoiding N per-name ADV calls). Sector enrichment, portal overrides, and the
 * registry diff happen in refresh() exactly as for the curated source — this only swaps the
 * candidate source. ONE active universe, no parallel pool.
 */
async function selectFromEodhdScan(
  rawInstruments: Awaited<ReturnType<typeof fetchT212Instruments>>,
  fxToGBP: FxToGBP,
  config: UniverseConfig,
): Promise<InstrumentMeta[]> {
  const candidates = await fetchEodhdCapScan({ minCapGbp: config.minCapGbp, exchanges: ['US', 'LSE'], fxToGBP });
  const { mapped, dropped } = mapEodhdToT212(candidates, rawInstruments);

  // Dedup by T212 ticker (a cross-listing could resolve twice); keep the larger cap.
  const byTicker = new Map<string, (typeof mapped)[number]>();
  for (const m of mapped) {
    const prev = byTicker.get(m.ticker);
    if (!prev || m.marketCapGbp > prev.marketCapGbp) byTicker.set(m.ticker, m);
  }
  const balanced = balanceByMarket([...byTicker.values()], config.maxSize);
  const usCount  = balanced.filter((m) => m.market === 'US').length;
  const lseCount = balanced.length - usCount;

  log.info(`[universe] eodhd_scan: ${candidates.length} >= £${(config.minCapGbp / 1e9).toFixed(1)}B, ${mapped.length} tradeable (${dropped} dropped), ${balanced.length} selected (${usCount} US / ${lseCount} LSE, cap ${config.maxSize})`);
  return balanced.map((m) => ({
    ticker:       m.ticker,
    name:         m.name,
    // Sector comes straight from the EODHD screener row (no Yahoo). refresh() step 4c
    // persists it to the meta cache; 'Unknown' only when the screener omitted it.
    sector:       m.sector && m.sector.trim() ? m.sector : 'Unknown',
    t212Tradable: true,
    market:       m.market,
  }));
}

export interface UniverseManagerOptions {
  // Optional injected sector client — defaults to the real Yahoo HTTP client. Tests
  // pass a stub. When set to `null`, sector enrichment is skipped entirely (useful
  // for tests that don't care about sectors and don't want the Yahoo call mocked).
  sectorClient?: YahooSectorClient | null;
  // Stale-window override (ms). Defaults to 30 days.
  sectorStaleMs?: number;
  // Resolves the effective max universe size at refresh time. Lets a portal runtime override
  // (portal_market_config) take precedence over the construction-time env default without a
  // restart. Omitted (or a non-positive/garbage return) falls back to the static config.maxSize.
  maxSizeResolver?: () => number | Promise<number>;
}

export class UniverseManager {
  private _activeUniverse: string[] = [];
  private _sectorMap: Record<string, string> = {};
  private readonly config: UniverseConfig;
  private readonly sectorClient: YahooSectorClient | null;
  private readonly sectorStaleMs: number;
  private readonly maxSizeResolver: (() => number | Promise<number>) | null;

  // Optional FX converter for liquidity ranking. Default (identity) keeps tests and
  // any caller that doesn't supply FX working — at the cost of incorrect cross-currency
  // ranking. Production wiring (services/market-data-service/src/index.ts) always
  // injects the live Yahoo-backed FxClient.
  constructor(
    private readonly fxToGBP: FxToGBP = IDENTITY_FX,
    config: Partial<UniverseConfig> = {},
    options: UniverseManagerOptions = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // `undefined` = use the default client; explicit `null` = disable enrichment.
    this.sectorClient = options.sectorClient === undefined ? new YahooSectorClient() : options.sectorClient;
    this.sectorStaleMs = options.sectorStaleMs ?? SECTOR_STALE_MS_DEFAULT;
    this.maxSizeResolver = options.maxSizeResolver ?? null;
  }

  // Effective max universe size for this refresh: the resolver's value (portal override) when sane,
  // else the static env/config default. Guards against a missing/garbage resolver return.
  private async resolveMaxSize(): Promise<number> {
    if (!this.maxSizeResolver) return this.config.maxSize;
    try {
      const n = await this.maxSizeResolver();
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : this.config.maxSize;
    } catch {
      return this.config.maxSize;
    }
  }

  /** Call once at startup, then monthly. */
  async refresh(): Promise<string[]> {
    const db = await getMongoDb();
    const now = new Date();

    // Effective config for THIS refresh: maxSize may be a live portal override (resolveMaxSize),
    // everything else is the static env config. Pass `cfg` (not this.config) to the selectors and
    // the eligibility cap so a portal change takes effect on the next refresh without a restart.
    const cfg: UniverseConfig = { ...this.config, maxSize: await this.resolveMaxSize() };

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
      log.warn('[universe] T212 instrument fetch failed, using existing registry:', err);
      // Fall back to whatever is already in the registry. The registry is keyed on (symbol, market)
      // since Task 16b — re-derive the T212 ticker per row (skipping a row whose identity can't be
      // re-joined, fail-soft) so the in-memory active set + sector map stay T212-keyed as before.
      const existing = await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY)
        .find({ activeTo: null })
        .toArray();
      this._activeUniverse = [];
      this._sectorMap = {};
      for (const d of existing as Array<{ symbol?: string; market?: string; sector?: string }>) {
        if (d.symbol == null || d.market == null) continue;
        const ticker = tickerOf(d.symbol, d.market);
        this._activeUniverse.push(ticker);
        this._sectorMap[ticker] = d.sector ?? 'Unknown';
      }
      return this._activeUniverse;
    }

    let selected: InstrumentMeta[];

    if (this.config.source === 'eodhd_scan') {
      // ── EODHD market-cap scan: the single universe source (US+LSE >= minCapGbp). ──
      // Feeds the same instrument_registry diff below — no parallel pool.
      selected = await selectFromEodhdScan(rawInstruments, this.fxToGBP, cfg);
    } else if (this.config.includeUs.length > 0 || this.config.includeLse.length > 0) {
      // ── 2/3/4 (curated): resolve include lists → ADV rank → top N ────────────
      // Each include-list symbol is matched against T212's `shortName` (the bare symbol,
      // e.g. "AAPL", "SHEL") and the best T212 ticker is picked per the market preference:
      // US list prefers `_US_EQ`, LSE list prefers GBP/GBX `l_EQ`. Unresolved symbols are
      // dropped — the log line reports how many. Liquidity comes from a one-shot Yahoo call
      // per candidate; ranking ensures stable selection across refreshes when the candidate
      // pool exceeds this.config.maxSize.
      selected = await selectCurated(rawInstruments, this.fxToGBP, cfg);
    } else {
      // ── 2. Fetch OHLCV stats for Section 29b eligibility filters ─────────────
      const allTickers = instruments.map((i) => i.ticker);
      const lookbackDate = new Date(now.getTime() - ADV_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

      // Aggregate 20-day ADV and latest close per name from stored OHLCV bars. Storage is keyed on
      // the bare identity (symbol, market) and stamps observation_ts (UTC ms), not the legacy
      // `timestamp` Date — split the T212 tickers, group on the identity over observation_ts, and
      // re-key back to the T212 ticker for the statsMap below. volume=0 from the T212 fill-price
      // approximation means the ADV filter is currently a pass-through; it activates once real
      // volume data flows.
      const adapter = new Trading212TickerAdapter();
      const statIds = allTickers.map((t) => ({ ticker: t, ...adapter.fromT212(t) }));
      const tickerByIdentity = new Map(statIds.map((i) => [`${i.symbol}|${i.market}`, i.ticker]));
      const lookbackMs = lookbackDate.getTime();
      const ohlcvStats = await db.collection(COLLECTIONS.OHLCV_BARS).aggregate([
        { $match: { $or: statIds.map((i) => ({ symbol: i.symbol, market: i.market })), observation_ts: { $gte: lookbackMs } } },
        { $sort: { observation_ts: 1 } },
        { $group: {
          _id: { symbol: '$symbol', market: '$market' },
          avgVolume:   { $avg: '$volume' },
          latestClose: { $last: '$close' },
        }},
      ]).toArray();

      const statsMap: Record<string, { avgVolume: number; latestClose: number }> = {};
      for (const s of ohlcvStats) {
        const id = s._id as { symbol: string; market: string };
        const ticker = tickerByIdentity.get(`${id.symbol}|${id.market}`);
        if (ticker === undefined) continue;
        statsMap[ticker] = { avgVolume: s.avgVolume as number ?? 0, latestClose: s.latestClose as number ?? 0 };
      }

      // ── 3. Apply eligibility filters (Section 29b) ───────────────────────────
      const priceAdvEligible = instruments.filter((i) => {
        if (!i.t212Tradable) return false;

        const stats = statsMap[i.ticker];
        if (!stats) return true;  // No OHLCV history yet (bootstrapping) — allow through

        // Price filter (Section 29b: ≥ £1)
        if (stats.latestClose > 0 && stats.latestClose < this.config.minPriceGbp) return false;

        // ADV filter (Section 29b: ≥ £2M). No-op when volume=0 (T212 limitation).
        if (stats.avgVolume > 0) {
          const adv = stats.avgVolume * stats.latestClose;
          if (adv < this.config.minAdvGbp) return false;
        }

        return true;
      });

      // Spread filter (Section 29b: ≤ 30bps) — NOW IMPLEMENTED via the quotes feed (was a no-op
      // when T212 was the only source). Trailing-7d median over real REGULAR quotes; tickers
      // without real quote history pass through (filter inactive until data accrues).
      const spreadMap = await medianSpreadByTicker(priceAdvEligible.map((i) => i.ticker));
      const eligible = priceAdvEligible.filter((i) => {
        const median = spreadMap.get(i.ticker);
        if (median != null && median > MAX_SPREAD_BPS) {
          log.info(`[universe] excluded ${i.ticker} median_bps=${median.toFixed(1)} > ${MAX_SPREAD_BPS}`);
          return false;
        }
        return true;
      });

      // ── 4. Sector-balance cap (Section 29c) ──────────────────────────────────
      // 'Unknown' is exempt: T212 instruments API provides no sector data, so all instruments
      // fall into 'Unknown' until enriched. Capping Unknown would silently truncate the universe.
      const sectorCap = Math.floor(cfg.maxSize * MAX_SECTOR_FRACTION);
      const sectorCount: Record<string, number> = {};
      selected = [];

      for (const inst of eligible) {
        if (selected.length >= cfg.maxSize) break;
        const sector = inst.sector;
        if (sector !== 'Unknown' && (sectorCount[sector] ?? 0) >= sectorCap) continue;
        selected.push(inst);
        sectorCount[sector] = (sectorCount[sector] ?? 0) + 1;
      }
    }

    // ── 4b. Portal overrides — applied AFTER eligibility/sector filtering ─────
    // Reason: forced adds/removes are an operator decision and must take precedence over
    // the criteria-driven selection. Removes win over T212 inclusion; adds bypass sector cap.
    // portal_universe_overrides stores adds/removes as { symbol, market } objects since Task 16b —
    // re-derive the T212 ticker per entry (fail-soft drop of an un-routable one) so the in-memory
    // override application below stays keyed on the T212 ticker exactly as before (the bare-forced-add
    // UX is Task 18/21). The bare-T212 set used for the addedReason='override_add' stamp is rebuilt
    // from these reconstructed strings too.
    const overridesDocRaw = await db.collection<OverridesDoc>(COLLECTIONS.PORTAL_UNIVERSE_OVERRIDES)
      .findOne({ _id: 'singleton' });
    const overridesDoc = overridesDocRaw === null ? null : {
      adds: identitiesToTickers(overridesDocRaw.adds),
      removes: identitiesToTickers(overridesDocRaw.removes),
    };

    const overrideResult = applyUniverseOverrides(selected, overridesDoc);
    selected = overrideResult.result;
    if (overrideResult.added || overrideResult.removed) {
      log.info(`[universe] overrides applied: +${overrideResult.added} -${overrideResult.removed}`);
    }

    // ── 4c. Sector enrichment — Mongo cache (read-through), sourced per universe source ─
    // Replaces the placeholder sector with a real label and persists it to the
    // `instrument_metadata` cache (read by the internal /sectors route + the registry diff).
    // - eodhd_scan: the sector arrives FREE on each selected row from the EODHD screener — NO
    //   Yahoo. Per-ticker quoteSummary melts at the ~500-name scanned universe (rate-limited),
    //   so we persist the screener sectors (source 'eodhd') and never call Yahoo here.
    // - curated/legacy: the low-volume, 30d-cached Yahoo enrichment (sectorClient) still runs.
    // - Operator overrides (source='manual') always win; failures keep the existing entry.
    const metaRepo = new MongoInstrumentMeta(db);
    const universeTickers = selected.map((i) => i.ticker);
    if (universeTickers.length > 0) {
      try {
        const existingMeta = await metaRepo.findMany(universeTickers);

        if (this.config.source === 'eodhd_scan') {
          let persisted = 0;
          for (const inst of selected) {
            if (existingMeta[inst.ticker]?.source === 'manual') continue;   // operator pin wins
            if (!inst.sector || inst.sector === 'Unknown') continue;        // screener had no sector
            await metaRepo.upsert({ ticker: inst.ticker, sector: inst.sector, source: 'eodhd' });
            persisted++;
          }
          log.info(`[universe] sector enrichment: ${persisted}/${universeTickers.length} from EODHD screener (no Yahoo)`);
        } else if (this.sectorClient) {
          const needFetch = await metaRepo.needsRefresh(universeTickers, this.sectorStaleMs);
          if (needFetch.length > 0) {
            log.info(`[universe] sector enrichment: ${needFetch.length}/${universeTickers.length} tickers need Yahoo lookup`);
            const fetched = await withTimeout(
              this.sectorClient.fetchSectors(needFetch),
              SECTOR_FETCH_TIMEOUT_MS, {}, 'sector enrichment',
            );
            for (const ticker of needFetch) {
              const hit = fetched[ticker];
              if (!hit) continue;   // Yahoo didn't resolve it — leave existing value (or absence)
              await metaRepo.upsert({
                ticker,
                sector:   hit.sector,
                source:   'yahoo',
                ...(hit.industry !== undefined ? { industry: hit.industry } : {}),
              });
            }
          }
        }

        // Build the in-memory sector map. Precedence: manual override > just-persisted
        // (eodhd/yahoo) > existing cache > the scan placeholder. Only falls to 'Unknown'
        // when no source ever resolved the ticker.
        const refreshed = await metaRepo.findMany(universeTickers);
        for (const inst of selected) {
          const row = refreshed[inst.ticker] ?? existingMeta[inst.ticker];
          if (row) inst.sector = row.sector;
        }
      } catch (err) {
        log.warn('[universe] sector enrichment failed — keeping previous sector map:', err);
      }
    }

    // ── 5. Diff against current registry — log additions and removals ──────────
    // The registry is keyed on the bare (symbol, market) identity since Task 16b. Build the split
    // identity per selected instrument once (skipping any name whose T212 ticker isn't a recognised
    // US/LSE form — fail-soft, never throw the refresh); the diff/insert/retire below all key on
    // (symbol, market). The universe-BUILDING above stays T212-internal (Task 18); this is the Mongo
    // storage boundary alone.
    const selectedIds = selected
      .map((i) => ({ inst: i, id: tryIdentityOf(i.ticker) }))
      .filter((x): x is { inst: InstrumentMeta; id: TickerIdentity } => x.id !== null);
    const idKey = (id: TickerIdentity) => `${id.symbol}|${id.market}`;
    const newIdKeys = new Set(selectedIds.map((x) => idKey(x.id)));

    const currentDocs = await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY)
      .find({ activeTo: null })
      .toArray() as Array<{ symbol?: string; market?: string }>;
    const currentIdKeys = new Set(
      currentDocs
        .filter((d) => d.symbol != null && d.market != null)
        .map((d) => `${d.symbol}|${d.market}`),
    );

    // Additions — split into true new inserts vs reactivations of previously-removed instruments.
    // insertMany would collide with the unique (symbol, market) index if a row already exists with
    // activeTo set, so a previously-retired identity is reactivated (updateMany) instead.
    const added = selectedIds.filter((x) => !currentIdKeys.has(idKey(x.id)));
    if (added.length > 0) {
      const existingDocs = await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY)
        .find({ $or: added.map((x) => ({ symbol: x.id.symbol, market: x.id.market })) })
        .toArray() as Array<{ symbol?: string; market?: string }>;
      const existingSet = new Set(
        existingDocs
          .filter((d) => d.symbol != null && d.market != null)
          .map((d) => `${d.symbol}|${d.market}`),
      );

      const toInsert     = added.filter((x) => !existingSet.has(idKey(x.id)));
      const toReactivate = added.filter((x) =>  existingSet.has(idKey(x.id)));

      if (toInsert.length > 0) {
        const overrideAdds = new Set(
          (overridesDoc?.adds ?? []).map((t) => t.toUpperCase().trim()),
        );
        await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY).insertMany(
          toInsert.map(({ inst: i, id }) => ({
            symbol:      id.symbol,
            market:      id.market,
            name:        i.name,
            sector:      i.sector,
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
          { $or: toReactivate.map((x) => ({ symbol: x.id.symbol, market: x.id.market })) },
          { $set: { activeTo: null, addedReason: 'universe_reactivation', updatedAt: now } },
        );
      }
      log.info(`[universe] added ${added.length} instruments: ${added.map((x) => x.inst.ticker).join(', ')}`);
    }

    // Refresh ADV + sector on every surviving entry so the portal table doesn't show stale
    // liquidity or a stale sector. (`market` is part of the key now, never re-written.) Skip when
    // fields are undefined (legacy path) so we don't blow away a known value with an empty one. The
    // sector backfill matters because the EODHD screener source (PR #8) only stamped sectors on
    // *newly inserted* rows — rows already active when the fix landed kept the 'Unknown' placeholder.
    // Only write a *resolved* sector so a transient screener/Yahoo miss never wipes a good label.
    const refreshUpdates = selectedIds.filter(({ inst: i }) => i.adv != null || i.sector != null);
    for (const { inst: i, id } of refreshUpdates) {
      const set: Record<string, unknown> = { updatedAt: now };
      if (i.adv != null) set.adv = i.adv;
      if (i.sector && i.sector !== 'Unknown') set.sector = i.sector;
      if (Object.keys(set).length === 1) continue;   // nothing but updatedAt — skip the write
      await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY).updateOne(
        { symbol: id.symbol, market: id.market, activeTo: null },
        { $set: set },
      );
    }

    // Removals (5-day grace period is tracked externally; we hard-remove here for v1)
    const removedDocs = currentDocs.filter(
      (d) => d.symbol != null && d.market != null && !newIdKeys.has(`${d.symbol}|${d.market}`),
    );
    if (removedDocs.length > 0) {
      await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY).updateMany(
        { $or: removedDocs.map((d) => ({ symbol: d.symbol, market: d.market })), activeTo: null },
        { $set: { activeTo: now, removedReason: 'universe_refresh', updatedAt: now } },
      );
      const removedTickers = removedDocs.map((d) => tickerOf(d.symbol as string, d.market as string));
      log.info(`[universe] removed ${removedDocs.length} instruments: ${removedTickers.join(', ')}`);
    }

    this._activeUniverse = selected.map((i) => i.ticker);
    this._sectorMap      = Object.fromEntries(selected.map((i) => [i.ticker, i.sector]));

    log.info(`[universe] active universe: ${this._activeUniverse.length} instruments`);
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
      .toArray() as Array<{ symbol?: string; market?: string }>;
    // The registry is keyed on (symbol, market) since Task 16b — re-derive the T212 ticker per row
    // (skip a row whose identity can't be re-joined, fail-soft) so the returned set stays T212-keyed.
    const out: string[] = [];
    for (const d of docs) {
      if (d.symbol == null || d.market == null) continue;
      out.push(tickerOf(d.symbol, d.market));
    }
    return out;
  }
}
