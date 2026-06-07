// Pure merge + rank for the portal entity-search aggregator (Research/Trading OS Task 20).
//
// The /portal-api/search route fans authedFetch to three existing list endpoints
// (active universe, strategy list, recent signals) and hands their raw bodies here.
// This module is intentionally free of `server-only` / `authedFetch` / Next so the
// merge/rank shape is unit-testable in plain vitest (the same split as command-registry
// and tabs — pure contract here, the I/O shell in the route handler).
//
// Frecency (per-user recency weighting) is deliberately NOT here — that is a later card
// (T21) and lives in the browser's localStorage. This stage ranks on relevance only:
// an exact symbol/id match outranks a prefix match, which outranks a substring match,
// with no-query falling back to the upstream's own order (cap-ranked universe, etc.).

/** A universe instrument result. Mirrors the fields T21 (⌘K) + T23 (SymbolPicker) render. */
export interface TickerResult {
  symbol: string
  name: string
  sector: string
  market: string
}

/** A strategy result. `active` marks the one currently selected by the strategy engine. */
export interface StrategyResult {
  id: string
  active: boolean
}

/** A recent-signal result. The minimal shape a picker needs to link to /signals/:id. */
export interface SignalResult {
  id: string
  ticker: string
  action: string
  strategy_id: string
  timestamp: number
}

/** The aggregator's response — the verbatim contract T21 + T23 consume. */
export interface SearchResults {
  tickers: TickerResult[]
  strategies: StrategyResult[]
  signals: SignalResult[]
}

// ── Upstream body shapes (the raw JSON each list endpoint returns) ──────────────
// Kept loose (every field optional) so a partial/degraded upstream body never throws
// here — a missing group is normalised to [] by the route, not crashed on.

/** GET /admin/api/market-data/universe/overrides */
export interface UniverseBody {
  activeUniverse?: string[]
  activeUniverseDetailed?: Array<{
    ticker?: string
    name?: string
    sector?: string
    market?: string
  }>
  sectorMap?: Record<string, string>
}

/** GET /admin/api/strategy/list */
export interface StrategyListBody {
  available?: string[]
  active?: string
}

/** GET /admin/api/signals/history */
export interface SignalsHistoryBody {
  signals?: Array<{
    id?: string
    ticker?: string
    action?: string
    strategy_id?: string
    timestamp?: number
  }>
}

// Relevance buckets — lower sorts first. A query that matches the symbol/id exactly is
// the strongest signal the operator means *that* entity; prefix beats an interior hit.
const RANK_EXACT = 0
const RANK_PREFIX = 1
const RANK_SUBSTRING = 2
const RANK_NONE = 3

/**
 * Score one candidate against the lower-cased query. `primary` is the identity field
 * (symbol / strategy id / signal ticker) — it carries the exact/prefix tiers; `extra`
 * fields (name, sector) only ever reach SUBSTRING, so a name match never outranks a
 * symbol prefix. Empty query ⇒ everything is RANK_NONE (upstream order preserved).
 */
function relevance(query: string, primary: string, ...extra: string[]): number {
  if (query === '') return RANK_NONE
  const p = primary.toLowerCase()
  if (p === query) return RANK_EXACT
  if (p.startsWith(query)) return RANK_PREFIX
  if (p.includes(query)) return RANK_SUBSTRING
  for (const e of extra) {
    if (e.toLowerCase().includes(query)) return RANK_SUBSTRING
  }
  return RANK_NONE
}

/**
 * Stable rank: keep the upstream order within a relevance bucket (a `.sort` on a
 * pre-indexed list — JS sort isn't guaranteed stable across engines for large inputs,
 * so we carry the original index as the tiebreaker). When a non-empty query is given,
 * candidates that match nothing (RANK_NONE) are dropped; an empty query keeps all.
 */
function rankBy<T>(items: T[], query: string, score: (item: T) => number): T[] {
  const indexed = items.map((item, i) => ({ item, i, r: score(item) }))
  const filtered = query === '' ? indexed : indexed.filter((x) => x.r !== RANK_NONE)
  filtered.sort((a, b) => a.r - b.r || a.i - b.i)
  return filtered.map((x) => x.item)
}

/** Normalise the universe body into ranked TickerResults. Prefers the detailed list
 *  (carries name/sector/market); falls back to bare symbols + sectorMap when absent. */
export function mergeTickers(body: UniverseBody, query: string): TickerResult[] {
  const detailed = body.activeUniverseDetailed
  let rows: TickerResult[]
  if (detailed && detailed.length > 0) {
    rows = detailed
      .filter((d): d is { ticker: string } & typeof d => typeof d.ticker === 'string' && d.ticker.length > 0)
      .map((d) => ({
        symbol: d.ticker,
        name: d.name ?? '',
        sector: d.sector ?? '',
        market: d.market ?? '',
      }))
  } else {
    const sectorMap = body.sectorMap ?? {}
    rows = (body.activeUniverse ?? [])
      .filter((t) => typeof t === 'string' && t.length > 0)
      .map((t) => ({ symbol: t, name: '', sector: sectorMap[t] ?? '', market: '' }))
  }
  return rankBy(rows, query, (t) => relevance(query, t.symbol, t.name, t.sector))
}

/** Normalise the strategy-list body into ranked StrategyResults, active flag preserved. */
export function mergeStrategies(body: StrategyListBody, query: string): StrategyResult[] {
  const active = body.active ?? ''
  const rows: StrategyResult[] = (body.available ?? [])
    .filter((id) => typeof id === 'string' && id.length > 0)
    .map((id) => ({ id, active: id === active }))
  return rankBy(rows, query, (s) => relevance(query, s.id))
}

/** Normalise the signals-history body into ranked SignalResults (ticker is the match key). */
export function mergeSignals(body: SignalsHistoryBody, query: string): SignalResult[] {
  const rows: SignalResult[] = (body.signals ?? [])
    .filter((s) => typeof s?.id === 'string' && typeof s?.ticker === 'string')
    .map((s) => ({
      id: s.id as string,
      ticker: s.ticker as string,
      action: s.action ?? '',
      strategy_id: s.strategy_id ?? '',
      timestamp: typeof s.timestamp === 'number' ? s.timestamp : 0,
    }))
  return rankBy(rows, query, (s) => relevance(query, s.ticker, s.strategy_id))
}

/**
 * Build the full grouped, ranked result from the three (possibly-null) upstream bodies.
 * A null body — what the route passes when that one upstream call failed or returned a
 * non-2xx — degrades just that group to [], so a single dead endpoint never empties the
 * other two (and never 500s the route).
 */
export function buildSearchResults(
  query: string,
  universe: UniverseBody | null,
  strategies: StrategyListBody | null,
  signals: SignalsHistoryBody | null,
): SearchResults {
  const q = query.toLowerCase().trim()
  return {
    tickers: universe ? mergeTickers(universe, q) : [],
    strategies: strategies ? mergeStrategies(strategies, q) : [],
    signals: signals ? mergeSignals(signals, q) : [],
  }
}
