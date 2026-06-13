// UniverseManager — builds and maintains the tradeable universe per Section 29.
// Applies eligibility filters (Section 29b) and sector-balance cap (Section 29c).
// All additions/removals are logged to instrument_registry for point-in-time reconstruction.

import { getMongoDb } from '@trader/shared-mongo';
import { COLLECTIONS } from '@trader/shared-mongo';
import { getPgPool } from '@trader/shared-pg';
import { Trading212TickerAdapter, type Market } from '@trader/ticker-identity';
import type { Currency } from '@trader/shared-types';
import { tryIdentityOf, tickerOf } from '../../../shared/identity.ts';
import { fetchT212Instruments } from '../infrastructure/t212-client.ts';
import { MongoInstrumentMeta } from '../infrastructure/MongoInstrumentMeta.ts';
import { EdgarSicSectorClient } from '../infrastructure/edgar-sic-sector-client.ts';
import { fetchEodhdCapScan } from '../infrastructure/eodhd-scan.ts';
import { mapEodhdToT212 } from '../infrastructure/eodhd-symbol-map.ts';
import { log } from '../../../logger.ts';

// Rows older than this are re-sourced on the next refresh (the curated/US EDGAR-SIC secondary). Sectors
// are stable for months so a long stale window is fine; the lower bound keeps us covered for the rare
// GICS reclassification (~quarterly) and lets the operator drop the env to force a re-pull.
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

// Sector enrichment is best-effort. Cap the call so a hung/cold fundamentals-api can never stall
// refresh() — and thus can never block the poll loop from starting. (The pattern dates to a 2026-05
// incident where refresh() hung on Yahoo's 429 wall during ADV ranking and market:raw went stale for
// ~3 days; the Yahoo ADV call + the Yahoo sector client are now gone — Task 19 — but the same hung-
// upstream guard is kept for the EDGAR-SIC secondary read.)
const SECTOR_FETCH_TIMEOUT_MS = 25_000;

// Race a promise against a timeout; on timeout OR rejection, resolve to `fallback`. The
// universe is still built from the resolved candidates, just without this enhancement
// (stale sectors), which the poll loop tolerates fine.
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

/**
 * A universe member, built natively on the bare `(symbol, market)` identity since Task 18. `symbol`
 * + `market` are the source of truth (written straight to instrument_registry); `ticker` is the
 * derived Trading212 string kept on the object for the in-memory active set, the provider routing,
 * and the override-application logic — the broker form lives only at this derived boundary, never in
 * storage.
 */
export interface InstrumentMeta {
  symbol:       string;       // bare exchange symbol (canonical, post-rename)
  market:       Market;       // 'US' | 'LSE' — the listing market
  ticker:       string;       // derived T212 ticker (adapter.toT212(symbol, market))
  name:         string;
  sector:       string;       // GICS sector (or 'Unknown' if not supplied)
  t212Tradable: boolean;
  adv?:         number;       // legacy ADV field — retained on the type for the registry row + any
                              // stored value, but no longer POPULATED (the Yahoo ADV rank was dropped
                              // in Task 19; curated ranking is shortName-stable, eodhd_scan ranks by cap)
}

const metaAdapter = new Trading212TickerAdapter();

/**
 * Build an InstrumentMeta from the bare identity, deriving the T212 `ticker` once. The single
 * construction seam so every selector + the override path produce the same `(symbol, market, ticker)`
 * triple — there is no place that hand-rolls the T212 string.
 */
function metaOf(fields: {
  symbol: string; market: Market; name: string; sector: string; t212Tradable: boolean; adv?: number;
}): InstrumentMeta {
  return {
    symbol:       fields.symbol,
    market:       fields.market,
    ticker:       metaAdapter.toT212({ symbol: fields.symbol, market: fields.market }),
    name:         fields.name,
    sector:       fields.sector,
    t212Tradable: fields.t212Tradable,
    ...(fields.adv !== undefined ? { adv: fields.adv } : {}),
  };
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

/** The identity-key form (`symbol|market`) used to dedup/match overrides against the selection. */
function idKeyOf(symbol: string, market: string): string { return `${symbol}|${market}`; }

/**
 * Normalise stored override entries to the canonical `(UPPER symbol, US/LSE market)` form, dropping an
 * empty-symbol or non-US/LSE entry. The SINGLE predicate for every override read site (the refresh
 * override-load + applyUniverseOverrides), so a stale/hand-edited doc with a lower-case or whitespace
 * symbol still matches the upper-cased selected set, and there is one place to change if the accepted
 * markets ever widen. Exported for unit testing.
 */
export function normaliseOverrideEntries(entries: OverrideEntry[] | undefined): OverrideEntry[] {
  return (entries ?? []).flatMap((e) => {
    if (!e || typeof e.symbol !== 'string') return [];
    const symbol = e.symbol.trim().toUpperCase();
    if (symbol === '' || (e.market !== 'US' && e.market !== 'LSE')) return [];
    return [{ symbol, market: e.market }];
  });
}

/**
 * Apply portal-driven adds/removes on top of the eligibility-filtered selection. Native to the bare
 * `(symbol, market)` identity since Task 18: adds/removes are `OverrideEntry`s (already resolved to a
 * tradable identity by the caller's bare-forced-add resolution), matched on `(symbol, market)` — so
 * the cross-listing ambiguity that a single T212 string couldn't express is gone.
 *
 * Removes win over inclusion; adds bypass the sector cap and are marked `t212Tradable=false` so
 * downstream code can detect operator-forced entries. Exported for unit testing.
 */
export function applyUniverseOverrides(
  selected: InstrumentMeta[],
  overrides: { adds?: OverrideEntry[]; removes?: OverrideEntry[] } | null,
): { result: InstrumentMeta[]; added: number; removed: number } {
  if (!overrides) return { result: selected, added: 0, removed: 0 };

  const removeSet = new Set(normaliseOverrideEntries(overrides.removes).map((e) => idKeyOf(e.symbol, e.market)));
  const before = selected.length;
  const result = selected.filter((i) => !removeSet.has(idKeyOf(i.symbol, i.market)));
  const removed = before - result.length;

  const present = new Set(result.map((i) => idKeyOf(i.symbol, i.market)));
  let added = 0;
  for (const e of normaliseOverrideEntries(overrides.adds)) {
    const key = idKeyOf(e.symbol, e.market);
    if (present.has(key)) continue;
    // A forced add bypasses the sector cap, carries 'Unknown' sector (enriched later if a source
    // resolves it), and is flagged non-tradable-by-criteria so downstream can detect operator forces.
    // `market` is part of the stored identity now, so the registry upsert renders the right region.
    result.push(metaOf({ symbol: e.symbol, market: e.market as Market, name: e.symbol, sector: 'Unknown', t212Tradable: false }));
    present.add(key);
    added++;
  }
  return { result, added, removed };
}

/** A T212 instrument indexed by bare shortName within each market — the shared resolution structure
 *  for the curated include lists AND the bare-forced-add resolver. US requires the `_US_EQ` form; LSE
 *  requires `l_EQ` with a GBP/GBX currency (London primary). First listing per (shortName, market) wins. */
export type T212MarketIndex = Record<Market, Record<string, { ticker: string; name: string }>>;

export function indexT212ByMarket(rawInstruments: Awaited<ReturnType<typeof fetchT212Instruments>>): T212MarketIndex {
  const byMarket: T212MarketIndex = { US: {}, LSE: {} };
  for (const inst of rawInstruments) {
    const sn = inst.shortName?.toUpperCase();
    if (!sn) continue;
    const isUS  = /_US_EQ$/.test(inst.ticker);
    const isLSE = /l_EQ$/.test(inst.ticker) && (inst.currencyCode === 'GBP' || inst.currencyCode === 'GBX');
    if (isUS && !byMarket.US[sn]) byMarket.US[sn] = { ticker: inst.ticker, name: inst.name };
    if (isLSE && !byMarket.LSE[sn]) byMarket.LSE[sn] = { ticker: inst.ticker, name: inst.name };
  }
  return byMarket;
}

/** A bare forced-add as it arrives on the wire: either a bare symbol string (`'GOOGL'`) or an explicit
 *  `{ symbol, market }`. The portal UI is Task 21; this is the backend's accepted input shape. `market`
 *  allows `undefined` to match the zod-inferred contract type under `exactOptionalPropertyTypes`. */
export type BareForcedAdd = string | { symbol: string; market?: string | undefined };

// The legacy symbols the adapter rename knows about (the LHS of the rename table) — kept narrow
// (FB→META today). A bare-add resolver probes these against the broker catalog so a name still echoed
// under its pre-rebrand shortName resolves regardless of which symbol the operator typed.
const LEGACY_RENAME_SOURCES = ['FB'] as const;

/** Legacy shortName aliases whose market-aware rename equals `canonical` (so the catalog can be probed
 *  under the pre-rebrand symbol when the broker metadata lags). */
function legacyAliasesFor(canonical: string, market: Market): string[] {
  return LEGACY_RENAME_SOURCES.filter(
    (legacy) => legacy !== canonical && metaAdapter.applyRename({ symbol: legacy, market }).symbol === canonical,
  );
}

/** A normalised forced-entry candidate: an upper-cased symbol + an optional explicit market. The single
 *  parse point for the three accepted shapes (bare string, legacy T212 string, `{symbol, market?}`), so
 *  case-handling + the legacy-T212 parse is identical for adds AND removes. Returns `null` on an empty
 *  symbol or an explicit-but-unsupported market. */
function normaliseForcedEntry(raw: BareForcedAdd): { symbol: string; market?: Market } | null {
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s === '') return null;
    // A legacy T212 string carries an explicit listing — parse it. The suffix match is case-sensitive
    // (`_US_EQ` upper, `l_EQ` lower-`l`), so try the canonical-case string first (handles `SGLNl_EQ`,
    // `AAPL_US_EQ`), then an upper-cased retry to catch a lower-cased US form (`aapl_us_eq` →
    // `AAPL_US_EQ`). Anything that still doesn't parse is treated as a bare symbol.
    for (const candidate of s === s.toUpperCase() ? [s] : [s, s.toUpperCase()]) {
      try { const id = metaAdapter.fromT212(candidate); return { symbol: id.symbol, market: id.market }; }
      catch { /* try the next candidate, else fall through to bare */ }
    }
    return { symbol: s.toUpperCase() };               // a bare symbol — market unspecified
  }
  const symbol = (raw.symbol ?? '').trim().toUpperCase();
  if (symbol === '') return null;
  const m = (raw.market ?? '').trim().toUpperCase();
  if (m === '') return { symbol };                  // market unspecified → caller's default
  if (m !== 'US' && m !== 'LSE') return null;        // an explicit non-US/LSE market is unsupported
  return { symbol, market: m as Market };
}

/**
 * Resolve a forced-add to a tradable `(symbol, market)` identity against the T212 catalog, reusing the
 * curated include-list resolution (shortName match per market) + the US-preferred cross-listing rule:
 *  - Accepts a bare symbol (`'GOOGL'`), a legacy T212 string (`'GOOGL_US_EQ'`/`'SHELl_EQ'`, the pre-bare
 *    portal form until Task 21), or a `{ symbol, market? }` object — all normalised the same way.
 *  - An explicit `market` (legacy-string listing OR object field) is honoured (the symbol must exist on
 *    that market in the catalog). A bare symbol (no market) defaults to **US** and, when cross-listed,
 *    prefers the US listing — falling back to LSE only when the symbol is LSE-only.
 *  - The market-aware rename (FB→META) is applied uniformly, so `FB`, `FB_US_EQ`, and `META` all resolve
 *    to the canonical `META` (the catalog is probed under the legacy shortName when the broker lags).
 *  - A symbol the catalog doesn't carry on the requested/any market → `null` (dropped, never a phantom).
 * Exported + pure (takes a pre-built index) for unit testing.
 */
export function resolveForcedAdd(raw: BareForcedAdd, index: T212MarketIndex): OverrideEntry | null {
  const norm = normaliseForcedEntry(raw);
  if (norm === null) return null;
  // Candidate markets in preference order. Explicit market → that one only. Bare → US then LSE
  // (US-preferred cross-listing), so a dual-listed name lands on its US listing as elsewhere.
  const markets: Market[] = norm.market ? [norm.market] : ['US', 'LSE'];

  for (const market of markets) {
    // Canonicalise per market (FB→META on US) before the catalog lookup. The catalog is probed under
    // BOTH the canonical symbol and any legacy alias that renames to it (FB for META) so a broker
    // catalog still echoing the pre-rebrand shortName resolves whether the operator typed the new
    // symbol (META) or the old one (FB) — the emitted identity is always canonical.
    const canonical = metaAdapter.applyRename({ symbol: norm.symbol, market }).symbol;
    const lookups = new Set<string>([canonical, norm.symbol, ...legacyAliasesFor(canonical, market)]);
    for (const sym of lookups) {
      if (index[market][sym]) return { symbol: canonical, market };
    }
  }
  return null;
}

/**
 * Resolve a forced-REMOVE to a `(symbol, market)` identity WITHOUT a catalog gate — a removed name may
 * be delisted/untradeable, so it need not exist in the live catalog (removes match the active set by
 * identity). Accepts the same three shapes as {@link resolveForcedAdd}; the market-aware rename
 * (FB→META) is applied so a remove keys the canonical identity. A bare symbol defaults to US (a
 * cross-listed bare remove should name its market explicitly — the active-set portal UI does, Task 21).
 * Returns `null` only for an empty symbol / an explicit unsupported market.
 */
export function resolveForcedRemove(raw: BareForcedAdd): OverrideEntry | null {
  const norm = normaliseForcedEntry(raw);
  if (norm === null) return null;
  const market: Market = norm.market ?? 'US';
  return { symbol: metaAdapter.applyRename({ symbol: norm.symbol, market }).symbol, market };
}

/**
 * Resolve each include-list symbol to the best T212 instrument, in include-list order.
 *
 * Resolution rules:
 *  - US list → prefer `_US_EQ` suffix (NYSE/NASDAQ primary).
 *  - LSE list → prefer `l_EQ` with GBP/GBX currency (London primary).
 *  - Match on T212 `shortName` (bare symbol). Symbols T212 doesn't carry are silently
 *    skipped; count logged.
 *
 * Dedup: collapse multiple include-list entries that resolve to the same underlying
 * (same shortName), keeping the first. This guards against future dual-listing additions
 * (e.g. SHEL appearing in both lists).
 *
 * RANKING (Task 19): the Yahoo 5-day-ADV rank was DROPPED — it was ineffective (T212 reports volume=0,
 * so the ADV the rank read was always 0) and Yahoo is removed platform-wide (Thread C). The curated
 * order is now the include-list order itself (US list then LSE list, first-listing-per-shortName wins),
 * which is stable across refreshes — the property the rank was there to provide when the candidate pool
 * exceeds maxSize. The live universe is `eodhd_scan` (ranked by market cap, not ADV); curated is the
 * fallback/test path. Returns at most this.config.maxSize entries with the sector cap applied (inert
 * until sector enrichment lands real labels — 'Unknown' is cap-exempt).
 */
function selectCurated(
  rawInstruments: Awaited<ReturnType<typeof fetchT212Instruments>>,
  config: UniverseConfig,
): InstrumentMeta[] {
  const includeUs  = config.includeUs;
  const includeLse = config.includeLse;
  const maxSize    = config.maxSize;
  // Shared shortName index (US prefers `_US_EQ`, LSE prefers GBP/GBX `l_EQ`, first per market wins).
  // T212 lists multiple cross-listings per symbol (e.g. VFEM has VFEMl_EQ, VFEMs_EQ, VFEMa_EQ); the
  // index keeps the canonical equity listing per market. The build is bare-native — `metaOf` derives
  // the T212 ticker from `(symbol, market)`, so no listing string is hand-rolled here.
  const byMarket = indexT212ByMarket(rawInstruments);

  const candidates: InstrumentMeta[] = [];
  const seenShortNames = new Set<string>();
  let unresolvedUS = 0;
  let unresolvedLSE = 0;

  for (const sym of includeUs) {
    const m = byMarket.US[sym];
    if (!m) { unresolvedUS++; continue; }
    if (seenShortNames.has(sym)) continue;
    seenShortNames.add(sym);
    candidates.push(metaOf({ symbol: sym, market: 'US', name: m.name, sector: 'Unknown', t212Tradable: true }));
  }
  for (const sym of includeLse) {
    const m = byMarket.LSE[sym];
    if (!m) { unresolvedLSE++; continue; }
    if (seenShortNames.has(sym)) {
      log.warn(`[universe] cross-listing dedup: ${sym} already in US pool, skipping LSE ${m.ticker}`);
      continue;
    }
    seenShortNames.add(sym);
    candidates.push(metaOf({ symbol: sym, market: 'LSE', name: m.name, sector: 'Unknown', t212Tradable: true }));
  }

  if (unresolvedUS || unresolvedLSE) {
    log.warn(`[universe] include-list unresolved: US=${unresolvedUS} LSE=${unresolvedLSE} (T212 has no matching instrument)`);
  }
  log.info(`[universe] curated candidates: ${candidates.length} (US: ${includeUs.length - unresolvedUS}, LSE: ${includeLse.length - unresolvedLSE})`);

  // No ADV rank (Task 19 — the Yahoo ADV call is gone; it read T212's volume=0 so it was always 0).
  // Candidates stay in include-list order, which is stable across refreshes (the property the rank
  // provided). Sectors are enriched later in refresh() (the curated/US EDGAR-SIC secondary).

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
 * maps to tradeable `(symbol, market)` identities, dedupes by identity, and selects a market-balanced
 * top set (100 US / 100 LSE at maxSize=200, via balanceByMarket — market cap is a sound liquidity
 * proxy at the >=£5B floor, avoiding N per-name ADV calls). Sector enrichment, portal overrides, and
 * the registry diff happen in refresh() exactly as for the curated source — this only swaps the
 * candidate source. ONE active universe, no parallel pool.
 */
async function selectFromEodhdScan(
  rawInstruments: Awaited<ReturnType<typeof fetchT212Instruments>>,
  fxToGBP: FxToGBP,
  config: UniverseConfig,
): Promise<InstrumentMeta[]> {
  const candidates = await fetchEodhdCapScan({ minCapGbp: config.minCapGbp, exchanges: ['US', 'LSE'], fxToGBP });
  const { mapped, dropped } = mapEodhdToT212(candidates, rawInstruments);

  // Dedup by the bare `(symbol, market)` identity (a cross-listing could resolve twice); keep the
  // larger cap. `(symbol, market)` disambiguates a cross-listed name that a single string couldn't.
  const byId = new Map<string, (typeof mapped)[number]>();
  for (const m of mapped) {
    const key = idKeyOf(m.symbol, m.market);
    const prev = byId.get(key);
    if (!prev || m.marketCapGbp > prev.marketCapGbp) byId.set(key, m);
  }
  const balanced = balanceByMarket([...byId.values()], config.maxSize);
  const usCount  = balanced.filter((m) => m.market === 'US').length;
  const lseCount = balanced.length - usCount;

  log.info(`[universe] eodhd_scan: ${candidates.length} >= £${(config.minCapGbp / 1e9).toFixed(1)}B, ${mapped.length} tradeable (${dropped} dropped), ${balanced.length} selected (${usCount} US / ${lseCount} LSE, cap ${config.maxSize})`);
  return balanced.map((m) => metaOf({
    symbol:       m.symbol,
    market:       m.market,
    name:         m.name,
    // Sector comes straight from the EODHD screener row (no Yahoo). refresh() step 4c
    // persists it to the meta cache; 'Unknown' only when the screener omitted it.
    sector:       m.sector && m.sector.trim() ? m.sector : 'Unknown',
    t212Tradable: true,
  }));
}

export interface UniverseManagerOptions {
  // Optional injected EDGAR-SIC sector client (the curated/US secondary source). Production wiring
  // (index.ts) injects the real `EdgarSicSectorClient` over FUNDAMENTALS_API_URL; tests pass a stub or
  // `null`. DEFAULT (undefined) is `null` — no secondary enrichment unless explicitly wired (the client
  // needs a base URL, so there is no zero-arg default; the eodhd_scan primary needs no client at all).
  sectorClient?: EdgarSicSectorClient | null;
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
  private readonly sectorClient: EdgarSicSectorClient | null;
  private readonly sectorStaleMs: number;
  private readonly maxSizeResolver: (() => number | Promise<number>) | null;

  // Optional FX converter. Default (identity) keeps tests and any caller that doesn't supply FX
  // working — at the cost of incorrect cross-currency cap normalisation under eodhd_scan. Production
  // wiring (services/market-data-service/src/index.ts) injects the live FxClient. (The curated path no
  // longer uses FX — the Yahoo ADV rank that needed it was dropped in Task 19 — but eodhd_scan does.)
  constructor(
    private readonly fxToGBP: FxToGBP = IDENTITY_FX,
    config: Partial<UniverseConfig> = {},
    options: UniverseManagerOptions = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // DEFAULT (undefined) = no secondary enrichment (`null`); production injects the real client. An
    // explicit `null` also disables it. The EdgarSicSectorClient needs a base URL → no zero-arg default.
    this.sectorClient = options.sectorClient ?? null;
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
      // Build natively on the bare identity (Task 18): split each T212 instrument to `(symbol, market)`
      // and drop any that isn't a US/LSE equity (OTHER/CFD/ETF oddballs — fail-soft, never enters the
      // universe). Only the no-include-list legacy path consumes `instruments`; the curated + eodhd_scan
      // sources build their own `(symbol, market)` candidates from the catalog.
      instruments = rawInstruments.flatMap((i) => {
        const id = tryIdentityOf(i.ticker);
        if (id === null) return [];
        return [metaOf({ symbol: id.symbol, market: id.market, name: i.name, sector: i.sector ?? 'Unknown', t212Tradable: true })];
      });
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
      // ── 2/3/4 (curated): resolve include lists → top N (include-list order) ───
      // Each include-list symbol is matched against T212's `shortName` (the bare symbol,
      // e.g. "AAPL", "SHEL") and the best T212 ticker is picked per the market preference:
      // US list prefers `_US_EQ`, LSE list prefers GBP/GBX `l_EQ`. Unresolved symbols are
      // dropped — the log line reports how many. The Yahoo ADV rank was dropped (Task 19);
      // selection is include-list order (stable across refreshes), capped at this.config.maxSize.
      selected = selectCurated(rawInstruments, cfg);
    } else {
      // ── 2. Fetch OHLCV stats for Section 29b eligibility filters ─────────────
      const lookbackDate = new Date(now.getTime() - ADV_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

      // Aggregate 20-day ADV and latest close per name from stored OHLCV bars. Storage is keyed on
      // the bare identity (symbol, market) and stamps observation_ts (UTC ms), not the legacy
      // `timestamp` Date. `instruments` already carries the native identity (Task 18), so group on
      // (symbol, market) directly and re-key to the derived T212 ticker for the statsMap. volume=0
      // from the T212 fill-price approximation means the ADV filter is a pass-through until real
      // volume data flows.
      const tickerByIdentity = new Map(instruments.map((i) => [idKeyOf(i.symbol, i.market), i.ticker]));
      const lookbackMs = lookbackDate.getTime();
      const ohlcvStats = await db.collection(COLLECTIONS.OHLCV_BARS).aggregate([
        { $match: { $or: instruments.map((i) => ({ symbol: i.symbol, market: i.market })), observation_ts: { $gte: lookbackMs } } },
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
        const ticker = tickerByIdentity.get(idKeyOf(id.symbol, id.market));
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
    // Reason: forced adds/removes are an operator decision and must take precedence over the
    // criteria-driven selection. Removes win over inclusion; adds bypass the sector cap. Since Task 18
    // the whole override path is native to the bare `(symbol, market)` identity: portal_universe_overrides
    // already stores adds/removes as { symbol, market } (Task 16b; the bare-forced-add resolution
    // happens at the admin PUT boundary), so they flow straight into applyUniverseOverrides with no
    // T212 round-trip. The override-add identity set drives the addedReason='override_add' stamp below.
    const overridesDocRaw = await db.collection<OverridesDoc>(COLLECTIONS.PORTAL_UNIVERSE_OVERRIDES)
      .findOne({ _id: 'singleton' });
    // Normalise the stored entries to the canonical (UPPER symbol, US/LSE market) form ONCE, so the
    // override_add stamp keys below match the identities applyUniverseOverrides actually adds (it
    // normalises internally too — keeping both sides on the same projection avoids a stale-case miss).
    const overrideAddEntries = normaliseOverrideEntries(overridesDocRaw?.adds);
    const overridesDoc = overridesDocRaw === null ? null : {
      adds: overrideAddEntries,
      removes: normaliseOverrideEntries(overridesDocRaw.removes),
    };

    const overrideResult = applyUniverseOverrides(selected, overridesDoc);
    selected = overrideResult.result;
    if (overrideResult.added || overrideResult.removed) {
      log.info(`[universe] overrides applied: +${overrideResult.added} -${overrideResult.removed}`);
    }

    // ── 4c. Sector enrichment — Mongo cache (read-through), sourced per universe source (Task 19) ─
    // Replaces the placeholder sector with a real label and persists it to the
    // `instrument_metadata` cache (read by the internal /sectors route + the registry diff).
    // - PRIMARY (eodhd_scan): the sector arrives FREE on each selected row from the EODHD screener
    //   (source 'eodhd') — no extra call. Yahoo is gone (Thread C).
    // - SECONDARY (curated/legacy): the EDGAR-SIC sector label from the PIT lake, via the
    //   `EdgarSicSectorClient` (source 'edgar'). US-only (non-US has no EDGAR); graceful — a cold/
    //   partial lake or an unmapped SIC leaves the name 'Unknown' (cap-exempt) and retries next refresh.
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
          log.info(`[universe] sector enrichment: ${persisted}/${universeTickers.length} from EODHD screener (primary)`);
        } else if (this.sectorClient) {
          // Curated/US secondary: the EDGAR SIC from the lake. needsRefresh skips manual pins + still-
          // fresh rows; the client itself filters to US names (non-US has no EDGAR) and degrades to {}.
          const needFetch = await metaRepo.needsRefresh(universeTickers, this.sectorStaleMs);
          if (needFetch.length > 0) {
            log.info(`[universe] sector enrichment: ${needFetch.length}/${universeTickers.length} tickers need an EDGAR-SIC lookup`);
            const fetched = await withTimeout(
              this.sectorClient.fetchSectors(needFetch),
              SECTOR_FETCH_TIMEOUT_MS, {}, 'sector enrichment',
            );
            let persisted = 0;
            for (const ticker of needFetch) {
              const sector = fetched[ticker];
              if (!sector) continue;   // EDGAR didn't sector it — leave existing value (or absence)
              await metaRepo.upsert({ ticker, sector, source: 'edgar' });
              persisted++;
            }
            log.info(`[universe] sector enrichment: ${persisted}/${needFetch.length} from EDGAR SIC (secondary)`);
          }
        }

        // Build the in-memory sector map. Precedence: manual override > just-persisted
        // (eodhd/edgar) > existing cache > the scan placeholder. Only falls to 'Unknown'
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
    // The registry is keyed on the bare (symbol, market) identity. Since Task 18 the universe is BUILT
    // natively on `(symbol, market)`, so `selected` IS the identity source here — no re-derivation from
    // a T212 string. The diff/insert/retire below all key on (symbol, market) straight off the meta.
    const idKey = (i: { symbol: string; market: string }) => idKeyOf(i.symbol, i.market);
    const newIdKeys = new Set(selected.map(idKey));

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
    const added = selected.filter((i) => !currentIdKeys.has(idKey(i)));
    if (added.length > 0) {
      const existingDocs = await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY)
        .find({ $or: added.map((i) => ({ symbol: i.symbol, market: i.market })) })
        .toArray() as Array<{ symbol?: string; market?: string }>;
      const existingSet = new Set(
        existingDocs
          .filter((d) => d.symbol != null && d.market != null)
          .map((d) => `${d.symbol}|${d.market}`),
      );

      const toInsert     = added.filter((i) => !existingSet.has(idKey(i)));
      const toReactivate = added.filter((i) =>  existingSet.has(idKey(i)));

      if (toInsert.length > 0) {
        // override_add stamp: the operator-forced identities, keyed on (symbol, market).
        const overrideAddKeys = new Set(overrideAddEntries.map((e) => idKeyOf(e.symbol, e.market)));
        await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY).insertMany(
          toInsert.map((i) => ({
            symbol:      i.symbol,
            market:      i.market,
            name:        i.name,
            sector:      i.sector,
            adv:         i.adv ?? 0,
            activeFrom:  now,
            activeTo:    null,
            addedReason: overrideAddKeys.has(idKey(i)) ? 'override_add' : 'universe_refresh',
            updatedAt:   now,
          })),
        );
      }
      if (toReactivate.length > 0) {
        await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY).updateMany(
          { $or: toReactivate.map((i) => ({ symbol: i.symbol, market: i.market })) },
          { $set: { activeTo: null, addedReason: 'universe_reactivation', updatedAt: now } },
        );
      }
      log.info(`[universe] added ${added.length} instruments: ${added.map((i) => i.ticker).join(', ')}`);
    }

    // Refresh ADV + sector on every surviving entry so the portal table doesn't show stale
    // liquidity or a stale sector. (`market` is part of the key now, never re-written.) Skip when
    // fields are undefined (legacy path) so we don't blow away a known value with an empty one. The
    // sector backfill matters because the EODHD screener source (PR #8) only stamped sectors on
    // *newly inserted* rows — rows already active when the fix landed kept the 'Unknown' placeholder.
    // Only write a *resolved* sector so a transient screener/Yahoo miss never wipes a good label.
    const refreshUpdates = selected.filter((i) => i.adv != null || i.sector != null);
    for (const i of refreshUpdates) {
      const set: Record<string, unknown> = { updatedAt: now };
      if (i.adv != null) set.adv = i.adv;
      if (i.sector && i.sector !== 'Unknown') set.sector = i.sector;
      if (Object.keys(set).length === 1) continue;   // nothing but updatedAt — skip the write
      await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY).updateOne(
        { symbol: i.symbol, market: i.market, activeTo: null },
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
