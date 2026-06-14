// Postgres-side reader for the Timescale `bars` hypertable. Parallels the
// Mongo-side getBars in index.ts: same Redis read-through cache, same fixed
// range-key set, same live-vs-asOf branching, same returned shape (OHLCVBar[]
// sorted oldest-first, fresh copy).
//
// Cache key namespace is `bars:pg:v1:…` rather than the Mongo writer's
// `bars:v2:…` so the two backends can run side-by-side (dual-write window) and
// the equivalence verification test (task 10) can compare them without one
// cache poisoning the other.
//
// SQL choices:
//   Live path  — partial-unique index `bars_latest_unique`. Single index scan,
//                no aggregation. Same cost shape as the Mongo partial-index
//                fast lane.
//   As-of path — `DISTINCT ON (observation_ts)` with `ORDER BY observation_ts
//                ASC, knowledge_ts DESC`. PG's native equivalent of Mongo's
//                `$sort+$group({$first})` pattern. The `bars_knowledge_lookup`
//                index makes the range scan cheap; DISTINCT ON does the
//                per-observation_ts pick.
//
// getBarAtOrBeforePg (below) is the single-bar at-or-before read the PIT
// enrichment uses — see its docstring + 0011_bars_asof_lookup.sql. It is the
// OOM-safe replacement for the `range='max'` series scan: a small window
// anchored at `asOf` (NOT at `now`) bounds the read so chunk-exclusion prunes
// to a handful of chunks on BOTH bounds — never the whole hypertable's lock
// table. Kept here beside the series reader (same cache namespace, same row
// mapper).

import type { RedisClientType } from 'redis';
import type { OHLCVBar, BarInterval } from '@trader/shared-types';
import type { TickerIdentity } from '@trader/ticker-identity';
import { getPgPool } from '@trader/shared-pg';

import type { GetBarsOpts, RangeKey } from './index.ts';
import { identityOf, tickerOf, identityKey } from './identity.ts';

const RANGE_DAYS: Record<RangeKey, number> = {
  '30d': 30,
  '60d': 60,
  '90d': 90,
  '180d': 180,
  '1y': 365,
  '2y': 730,
  '5y': 1825,
  'max': 36500,
};

const CACHE_TTL_SECONDS = 3600;

interface CachedSeries {
  v: 1;
  cachedAt: number;
  bars: OHLCVBar[];
}

function asOfBucket(asOf: number | undefined): string {
  if (asOf === undefined) return 'live';
  return String(Math.floor(asOf / 60_000));
}

export function pgCacheKey(ticker: string, interval: BarInterval, range: RangeKey, asOf?: number): string {
  const id = identityOf(ticker);
  return `bars:pg:v1:${identityKey(id.symbol, id.market)}:${interval}:${range}:${asOfBucket(asOf)}`;
}

/**
 * Read a time-sorted OHLCV series from Timescale. Mirrors getBars(): Redis
 * first, PG on miss, populate cache. Empty array if nothing matches.
 *
 * @param redis  shared-redis client. Only `get`/`setEx` are used.
 * @param ticker  e.g. `AAPL_US_EQ`.
 * @param interval  `'5m' | '15m' | '1h' | 'daily'`. Storage is 5m; the dispatcher
 *                 in index.ts handles aggregation to coarser intervals on the way out.
 * @param range  Range key — '30d'/'60d'/'90d'/'180d'. Fixed set keeps cache hit
 *              rate high across consumers.
 * @param opts.asOf  Knowledge-time cutoff (UTC ms). Omitted = "as of now",
 *                  the partial-unique-index fast lane.
 */
export async function getBarsFromPg(
  redis: Pick<RedisClientType, 'get' | 'setEx'>,
  ticker: string,
  interval: BarInterval,
  range: RangeKey,
  opts: GetBarsOpts = {},
): Promise<OHLCVBar[]> {
  const asOf = opts.asOf;
  const key = pgCacheKey(ticker, interval, range, asOf);
  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedSeries;
      if (parsed.v === 1 && Array.isArray(parsed.bars)) return parsed.bars;
    }
  } catch (err) {
    // Cache read failure never blocks a request — fall through to PG.
    console.warn(`[shared-bars/pg] cache read failed for ${key}:`, err);
  }

  const sinceTs = Date.now() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000;
  const pool = getPgPool();
  const { symbol, market } = identityOf(ticker);

  let bars: OHLCVBar[];
  if (asOf === undefined) {
    // Live path — partial-unique index fast lane. `is_superseded = FALSE` picks
    // exactly one row per (symbol, market, observation_ts, interval).
    const { rows } = await pool.query(
      `SELECT symbol, market, observation_ts, knowledge_ts, interval,
              open, high, low, close, volume,
              raw_close, adjusted_close, adjustment_factor,
              currency, content_hash, is_superseded
         FROM bars
        WHERE symbol = $1
          AND market = $2
          AND interval = $3
          AND is_superseded = FALSE
          AND observation_ts >= $4
        ORDER BY observation_ts ASC`,
      [symbol, market, interval, sinceTs],
    );
    bars = rows.map(rowToBar);
  } else {
    // As-of path — `DISTINCT ON (observation_ts) ... ORDER BY observation_ts ASC,
    // knowledge_ts DESC` is the PG-native equivalent of Mongo's
    // `$sort+$group({$first})`. The bars_knowledge_lookup index covers the range.
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (observation_ts)
              symbol, market, observation_ts, knowledge_ts, interval,
              open, high, low, close, volume,
              raw_close, adjusted_close, adjustment_factor,
              currency, content_hash, is_superseded
         FROM bars
        WHERE symbol = $1
          AND market = $2
          AND interval = $3
          AND observation_ts >= $4
          AND knowledge_ts <= $5
        ORDER BY observation_ts ASC, knowledge_ts DESC`,
      [symbol, market, interval, sinceTs, asOf],
    );
    bars = rows.map(rowToBar);
  }

  try {
    const payload: CachedSeries = { v: 1, cachedAt: Date.now(), bars };
    await redis.setEx(key, CACHE_TTL_SECONDS, JSON.stringify(payload));
  } catch (err) {
    console.warn(`[shared-bars/pg] cache write failed for ${key}:`, err);
  }

  return bars;
}

/**
 * Latest unsuperseded `interval` bars at/after `sinceTs` for a SET of (symbol, market) identities,
 * read from Timescale. The set-form mirror of getBarsFromPg's live path (the `is_superseded = FALSE`
 * fast lane): a single `(symbol, market) IN (...)` scan instead of one query per ticker — what the
 * daily-emit needs to fold "every active universe ticker's 5m bars since UTC-midnight" into one read.
 *
 * Bounded BELOW by `observation_ts >= sinceTs` — the load-bearing OOM-safe rule (same as
 * getBarsFromPg / getBarAtOrBefore). With both the name set and the `observation_ts >=` floor on the
 * time dimension, chunk-exclusion prunes the plan to the day's chunks; without the floor the planner
 * would Merge-Append every chunk of the deep `bars` hypertable and lock them all at executor startup
 * → lock-table exhaustion → "out of shared memory" (the bug the bars-OOM work fights). The partial
 * index bars_asof_lookup `(symbol, market, interval, observation_ts DESC) WHERE is_superseded = FALSE`
 * backs the scan.
 *
 * No Redis cache: this is the live emit's per-cycle read of a moving "today" window over the whole
 * universe — a cache keyed on the (set, sinceTs) tuple would miss every cycle and only add a write.
 * Returns OHLCVBar[] oldest-first, the T212 `ticker` re-derived per row (the OHLCVBar contract is
 * unchanged); empty array when `ids` is empty or nothing matches.
 */
export async function getRecentBarsForTickersPg(
  ids: ReadonlyArray<TickerIdentity>,
  { interval, sinceTs }: { interval: BarInterval; sinceTs: number },
): Promise<OHLCVBar[]> {
  if (ids.length === 0) return [];
  const pool = getPgPool();

  // Build parameterised `(symbol, market)` tuples — $1=symbol0, $2=market0, $3=symbol1, … — then the
  // trailing two binds for interval + sinceTs. Never interpolate identities into SQL text (injection
  // + plan-cache churn): every value is a placeholder.
  const params: Array<string | number> = [];
  const tuples = ids.map((id) => {
    params.push(id.symbol, id.market);
    return `($${params.length - 1}, $${params.length})`;
  });
  const intervalIdx = params.push(interval);
  const sinceIdx = params.push(sinceTs);

  const { rows } = await pool.query(
    `SELECT symbol, market, observation_ts, knowledge_ts, interval,
            open, high, low, close, volume,
            raw_close, adjusted_close, adjustment_factor,
            currency, content_hash, is_superseded
       FROM bars
      WHERE (symbol, market) IN (${tuples.join(', ')})
        AND interval = $${intervalIdx}
        AND is_superseded = FALSE
        AND observation_ts >= $${sinceIdx}
      ORDER BY observation_ts ASC`,
    params,
  );
  return rows.map(rowToBar);
}

// Window size for the observed-ts walk. The gap planner hands ranges as wide as the daily backfill's
// 5y default (or the 35y deep-backfill) — and a SINGLE query bounded only at the range edges still
// opens (and locks) EVERY 7-day chunk in that multi-year span at executor startup → "out of shared
// memory" (the range='max' lock-fan; the OOM-safe rule is "prune to a SMALL slice", not just "have a
// bound"). So the read walks the requested range in bounded ~2-year windows — each query's
// `observation_ts >= lo AND < hi` prunes chunk-exclusion to that window's ~104 chunks — exactly the
// getDailyDepthPg pattern. A 60d 5m range is a single window; a 35y daily range is ~18.
const OBSERVED_WALK_WINDOW_MS = 730 * 24 * 60 * 60 * 1000; // 2 years ≈ 104 7-day chunks per query.
// Same bounded-window size for the per-set count walk (countBarsForTickersPg) — keeps each windowed
// count(*) plan under the lock budget regardless of how wide a `sinceMs` the caller passes.
const COUNT_WALK_WINDOW_MS = 730 * 24 * 60 * 60 * 1000; // 2 years ≈ 104 7-day chunks per query.

/**
 * Observed unsuperseded `observation_ts` values for ONE ticker within `[sinceMs, untilMs]`, from
 * Timescale. The set-of-timestamps the gap-aware fetch planner (`planGapWindows`) diffs against the
 * step grid to find the windows it must re-fetch. The range is WALKED in bounded ~2-year windows so no
 * single query plan spans more chunks than one window holds — the OOM-safe rule (a single query over
 * the daily backfill's multi-year range would lock every chunk → "out of shared memory"; see
 * OBSERVED_WALK_WINDOW_MS). Live (`is_superseded = FALSE`) rows only — the same fast lane the gap
 * planner's Mongo branch reads. Returns the raw `observation_ts` numbers (no row mapping — the planner
 * only needs the timestamps), accumulated across windows.
 */
export async function getObservedTimestampsPg(
  ticker: string,
  interval: BarInterval,
  sinceMs: number,
  untilMs: number,
): Promise<number[]> {
  if (untilMs < sinceMs) return [];
  const pool = getPgPool();
  const { symbol, market } = identityOf(ticker);
  const out: number[] = [];
  // Walk [sinceMs, untilMs] in bounded windows. Each query is bounded on BOTH sides of the time
  // dimension, so the planner prunes to that window's chunks — never the whole multi-year range.
  for (let lo = sinceMs; lo <= untilMs; lo += OBSERVED_WALK_WINDOW_MS) {
    const hi = Math.min(lo + OBSERVED_WALK_WINDOW_MS - 1, untilMs); // inclusive upper edge per window
    const { rows } = await pool.query<{ observation_ts: string }>(
      `SELECT observation_ts
         FROM bars
        WHERE symbol = $1
          AND market = $2
          AND interval = $3
          AND is_superseded = FALSE
          AND observation_ts >= $4
          AND observation_ts <= $5`,
      [symbol, market, interval, lo, hi],
    );
    for (const r of rows) out.push(Number(r.observation_ts));
  }
  return out;
}

/**
 * Unsuperseded `interval` bar COUNT per (symbol, market) identity in a SET, from Timescale, over
 * `[sinceMs, now]`. Backs the bootstrap "does this ticker have ≥N bars?" checks
 * (`tickersMissingHistory` / `tickersMissingDailyHistory`) and is the per-set count behind `/coverage`.
 * Returns a Map keyed `${symbol}|${market}` (only names with ≥1 row in the window appear; absent ⇒ 0).
 *
 * OOM-safe by WALKING `[sinceMs, now]` in bounded ~2-year windows and summing per identity — a
 * `sinceMs`-only lower bound is NOT enough on its own: the daily threshold needs ≥~400 days of window
 * (to fit the ~280-bar `minBars`), and the daily-backfill gate passes a multi-year `sinceMs`, so a
 * single `count(*) … observation_ts >= sinceMs` would still open (and lock) every chunk back to the
 * floor → "out of shared memory" (the default max_locks_per_transaction is 64; a 3y span is ~156
 * chunks). Each windowed query's `observation_ts >= lo AND < hi` prunes chunk-exclusion to ~104 chunks
 * (the getDailyDepthPg pattern). A 5m 75d call is a single window; a daily 3y call is ~2. The
 * `(symbol, market, interval, observation_ts DESC) WHERE is_superseded = FALSE` partial index
 * (`bars_asof_lookup`) backs each window scan.
 */
export async function countBarsForTickersPg(
  ids: ReadonlyArray<TickerIdentity>,
  interval: BarInterval,
  sinceMs: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const pool = getPgPool();
  const symbols = ids.map((id) => id.symbol);
  const markets = ids.map((id) => id.market);
  const nowMs = Date.now();
  // Walk forward in bounded windows so no single aggregate plan spans more chunks than one window
  // holds. +DAY_MS on the final upper edge so the newest bar's window is inclusive.
  for (let lo = sinceMs; lo < nowMs; lo += COUNT_WALK_WINDOW_MS) {
    const hi = Math.min(lo + COUNT_WALK_WINDOW_MS, nowMs + 24 * 60 * 60 * 1000);
    const { rows } = await pool.query<{ symbol: string; market: string; n: string }>(
      `SELECT symbol, market, count(*)::bigint AS n
         FROM bars
        WHERE (symbol, market) IN (
                SELECT unnest($1::text[]), unnest($2::text[])
              )
          AND interval = $3
          AND is_superseded = FALSE
          AND observation_ts >= $4
          AND observation_ts < $5
        GROUP BY symbol, market`,
      [symbols, markets, interval, lo, hi],
    );
    for (const r of rows) {
      const key = `${r.symbol}|${r.market}`;
      out.set(key, (out.get(key) ?? 0) + Number(r.n));
    }
  }
  return out;
}

/**
 * Unsuperseded `interval` bar count per (symbol, market) across the WHOLE store (no identity set),
 * from Timescale, bounded below by `sinceMs`. The set-free companion to `countBarsForTickersPg` — backs
 * the admin `/coverage` endpoint, which reports every name that has bars, not a fixed universe. The
 * `sinceMs` floor is the OOM-safe bound (an unbounded whole-store group-by locks every chunk); the
 * caller passes the interval's natural window (5m: ~60d provider cap). Returns a Map keyed
 * `${symbol}|${market}`.
 */
export async function countAllBarsPg(
  interval: BarInterval,
  sinceMs: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const pool = getPgPool();
  const { rows } = await pool.query<{ symbol: string; market: string; n: string }>(
    `SELECT symbol, market, count(*)::bigint AS n
       FROM bars
      WHERE interval = $1
        AND is_superseded = FALSE
        AND observation_ts >= $2
      GROUP BY symbol, market`,
    [interval, sinceMs],
  );
  for (const r of rows) out.set(`${r.symbol}|${r.market}`, Number(r.n));
  return out;
}

/**
 * Latest unsuperseded `observation_ts` per (symbol, market) identity in a SET, from Timescale, bounded
 * below by `sinceMs`. Backs the self-heal gap detector (`healMissingHistory`) — the `$group({$max})`
 * the Mongo branch ran, dispatched so heal reads the store the writer now writes to. Returns a Map
 * keyed `${symbol}|${market}` (only names with ≥1 row in the window appear). Same `sinceMs` OOM bound
 * + `bars_asof_lookup` index as the count read; heal works the 5m series so the bound is the 60d
 * provider cap. The `MAX(observation_ts)` aggregate over the bounded window is index-backed.
 */
export async function latestObservationForTickersPg(
  ids: ReadonlyArray<TickerIdentity>,
  interval: BarInterval,
  sinceMs: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const pool = getPgPool();
  const symbols = ids.map((id) => id.symbol);
  const markets = ids.map((id) => id.market);
  const { rows } = await pool.query<{ symbol: string; market: string; latest: string }>(
    `SELECT symbol, market, max(observation_ts) AS latest
       FROM bars
      WHERE (symbol, market) IN (
              SELECT unnest($1::text[]), unnest($2::text[])
            )
        AND interval = $3
        AND is_superseded = FALSE
        AND observation_ts >= $4
      GROUP BY symbol, market`,
    [symbols, markets, interval, sinceMs],
  );
  for (const r of rows) out.set(`${r.symbol}|${r.market}`, Number(r.latest));
  return out;
}

/** One row of the bar-revision audit ledger, identity-keyed (symbol, market). */
export interface BarRevisionLogRow {
  symbol: string;
  market: string;
  observation_ts: number;
  interval: string;
  knowledge_ts: number;
  prior_hash: string | null;
  new_hash: string;
}

/**
 * Per-(symbol, market) revision COUNT for `interval` from the Timescale `bar_revisions_log` ledger,
 * EXCLUDING first-prints (`prior_hash IS NOT NULL`) — the genuine-revisions count the `/coverage`
 * endpoint reports beside the bar count. The PG writer writes this ledger in the SAME transaction as
 * each bar supersede, so post-flip the revisions live here, not in Mongo. `bar_revisions_log` is a
 * small append-only ledger (one row per revision/first-print, NOT per bar) — its chunk count is tiny
 * relative to `bars`, so an interval-scoped scan is cheap; no window bound is needed for correctness or
 * lock safety here. Returns a Map keyed `${symbol}|${market}`.
 */
export async function countRevisionsForTickersPg(
  interval: BarInterval,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const pool = getPgPool();
  const { rows } = await pool.query<{ symbol: string; market: string; n: string }>(
    `SELECT symbol, market, count(*)::bigint AS n
       FROM bar_revisions_log
      WHERE interval = $1
        AND prior_hash IS NOT NULL
      GROUP BY symbol, market`,
    [interval],
  );
  for (const r of rows) out.set(`${r.symbol}|${r.market}`, Number(r.n));
  return out;
}

/**
 * The bi-temporal revision audit trail for ONE ticker since a knowledge instant, newest-first, from
 * the Timescale `bar_revisions_log` ledger — the operator-facing `/revisions/:ticker` read, dispatched
 * so it reflects the store the writer now writes its audit log to. Bounded by `knowledge_ts >= since`
 * + `LIMIT`. Returns identity-keyed rows; the route re-derives the T212 ticker for display.
 */
export async function getRevisionsForTickerPg(
  symbol: string,
  market: string,
  since: number,
  limit: number,
): Promise<BarRevisionLogRow[]> {
  const pool = getPgPool();
  const { rows } = await pool.query<{
    symbol: string; market: string; observation_ts: string; interval: string;
    knowledge_ts: string; prior_hash: string | null; new_hash: string;
  }>(
    `SELECT symbol, market, observation_ts, interval, knowledge_ts, prior_hash, new_hash
       FROM bar_revisions_log
      WHERE symbol = $1
        AND market = $2
        AND knowledge_ts >= $3
      ORDER BY knowledge_ts DESC
      LIMIT $4`,
    [symbol, market, since, limit],
  );
  return rows.map((r) => ({
    symbol: r.symbol,
    market: r.market,
    observation_ts: Number(r.observation_ts),
    interval: r.interval,
    knowledge_ts: Number(r.knowledge_ts),
    prior_hash: r.prior_hash,
    new_hash: r.new_hash,
  }));
}

interface CachedBar {
  v: 1;
  cachedAt: number;
  bar: OHLCVBar | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The at-or-before read is bounded BELOW at `asOf` (NOT at `now`) so chunk-exclusion engages on
// BOTH the upper (`observation_ts <= asOf`) AND the lower (`observation_ts > asOf - window`) bound.
// Without a lower bound, Timescale acquires a lock on every chunk of the `bars` hypertable at
// executor startup — *before* `LIMIT 1` can short-circuit — so a deep daily series (≈1700+ 7-day
// chunks back to the 1990s) exhausts the lock table → "out of shared memory" (lock.c
// LockAcquireExtended). The window is anchored at `asOf`, so a 2006 read touches only the ~57 chunks
// around 2006 and a 'now' read only the recent ones; deep history stays reachable, the plan never
// spans the whole hypertable. This is distinct from the original now-anchored `range='max'` bug:
// that anchored the lower bound at `now`, clipping a deep as-of to nothing AND still fanning every
// chunk for 'now'; this anchors at `asOf`.
//
// Two tiers: a small primary window covers the dense steady-state (a daily series with no recent
// gap returns from the first ~400 days); on empty we expand ONCE to a wider but still-bounded window
// (≈5 years) to clear a long pre-asOf hole (a sparsely-backfilled or recently-onboarded ticker)
// before returning `null`. We never widen to the whole hypertable — a name with truly no bar within
// 5 years of asOf is reported absent, never at the cost of a full-chunk lock fan.
const AT_PRIMARY_WINDOW_MS = 400 * DAY_MS; // ~57 7-day chunks — the steady-state fast lane.
const AT_WIDE_WINDOW_MS = 5 * 365 * DAY_MS; // ~260 7-day chunks — the bounded fallback, still safe.

// Depth-probe window. The depth-check (getDailyDepthPg) walks [floor, now] in windows of this size so
// no single COUNT/MIN aggregate spans the whole hypertable (an unbounded aggregate would lock every
// chunk → the same OOM the at-or-before read had to kill — see the regression in at-or-before.test.ts).
// 2 years ≈ 104 7-day chunks per window: a bounded lock footprint per query, and ~18 windows to cover
// a 1990→now span (the deep floor below) — cheap, index-backed by bars_asof_lookup.
const DEPTH_WINDOW_DAYS = 730;
const DEPTH_WINDOW_MS = DEPTH_WINDOW_DAYS * DAY_MS;
// Default deep floor: 1990-01-01 UTC. Deeper than SPY's 1993 inception (the deepest series a 35y
// DAILY_BACKFILL_YEARS seeds), so the walk always starts before any real bar; a name whose oldest bar
// is 2006 simply yields empty (chunk-pruned, cheap) windows from 1990→2006 before its first row.
const DEPTH_FLOOR_MS = Date.UTC(1990, 0, 1);

/**
 * Cache key for the single-bar at-or-before read. Distinct `:at:` segment so it never
 * collides with the windowed-series keys (`pgCacheKey`) — a series read and a single-bar
 * read for the same (ticker, interval, asOf) are different shapes.
 */
export function pgAtCacheKey(ticker: string, interval: BarInterval, asOf?: number): string {
  const id = identityOf(ticker);
  return `bars:pg:v1:${identityKey(id.symbol, id.market)}:${interval}:at:${asOfBucket(asOf)}`;
}

// One bounded query: the latest bar in `(anchor - windowMs, anchor]`. Live (`isLive`) filters the
// `is_superseded=FALSE` fast lane; as-of additionally filters `knowledge_ts <= anchor` and orders
// by `knowledge_ts DESC` so the latest revision known by then wins. `ORDER BY observation_ts DESC,
// knowledge_ts DESC LIMIT 1` already returns the newest observation's latest-knowledge row — no
// `DISTINCT ON` is needed (a single row, not a per-observation set). Both bounds are on the
// hypertable's time dimension, so the planner prunes to the chunks the window touches.
async function queryBarInWindow(
  pool: ReturnType<typeof getPgPool>,
  ticker: string,
  interval: BarInterval,
  anchor: number,
  windowMs: number,
  isLive: boolean,
): Promise<OHLCVBar | null> {
  const lowerBound = anchor - windowMs;
  const { symbol, market } = identityOf(ticker);
  // $1=symbol $2=market $3=interval $4=anchor (upper bound) $5=lowerBound. The window bounds
  // ($4 upper / $5 lower on observation_ts) are the load-bearing OOM fix — chunk-exclusion prunes
  // on BOTH bounds — and are unchanged here; only the name filter moved from `ticker` to the two
  // identity columns (now backed by the re-keyed bars_asof_lookup index).
  const sql = isLive
    ? `SELECT symbol, market, observation_ts, knowledge_ts, interval,
              open, high, low, close, volume,
              raw_close, adjusted_close, adjustment_factor,
              currency, content_hash, is_superseded
         FROM bars
        WHERE symbol = $1
          AND market = $2
          AND interval = $3
          AND is_superseded = FALSE
          AND observation_ts <= $4
          AND observation_ts > $5
        ORDER BY observation_ts DESC
        LIMIT 1`
    : `SELECT symbol, market, observation_ts, knowledge_ts, interval,
              open, high, low, close, volume,
              raw_close, adjusted_close, adjustment_factor,
              currency, content_hash, is_superseded
         FROM bars
        WHERE symbol = $1
          AND market = $2
          AND interval = $3
          AND observation_ts <= $4
          AND observation_ts > $5
          AND knowledge_ts <= $4
        ORDER BY observation_ts DESC, knowledge_ts DESC
        LIMIT 1`;
  const { rows } = await pool.query(sql, [symbol, market, interval, anchor, lowerBound]);
  return rows[0] ? rowToBar(rows[0]) : null;
}

/**
 * The single latest bar at/<= a knowledge instant — `null` when none qualifies. This is the
 * OOM-safe replacement for `getBarsFromPg(..., 'max', { asOf })` in the PIT market-cap /
 * dividend-yield enrichment. The read is **bounded BELOW at `asOf`** (a `~400d` primary window,
 * expanded once to `~5y` on a miss) so chunk-exclusion prunes to a bounded slice of chunks on BOTH
 * the upper and lower bound — a deep 2006 as-of touches only the chunks around 2006 and 'now'
 * touches only the recent ones. The old `range='max'` scan (and the first cut of this read, which
 * had no lower bound at all) let Timescale acquire a lock on **every** chunk at executor startup
 * before `LIMIT 1` could short-circuit, exhausting the lock table → "out of shared memory" → a 500
 * to the enrichment caller. The `asOf`-anchored window is what keeps a deep read reachable WITHOUT
 * the full-chunk lock fan. See AT_PRIMARY_WINDOW_MS / AT_WIDE_WINDOW_MS above.
 *
 * @param opts.asOf  Knowledge-time cutoff (UTC ms). Omitted = live (the `is_superseded=FALSE`
 *                  fast lane, anchored at `now`). Set = the latest revision known at that instant
 *                  (audit / replay), anchored at `asOf`.
 */
export async function getBarAtOrBeforePg(
  redis: Pick<RedisClientType, 'get' | 'setEx'>,
  ticker: string,
  interval: BarInterval,
  opts: GetBarsOpts = {},
): Promise<OHLCVBar | null> {
  const asOf = opts.asOf;
  const key = pgAtCacheKey(ticker, interval, asOf);
  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedBar;
      if (parsed.v === 1 && 'bar' in parsed) return parsed.bar;
    }
  } catch (err) {
    // Cache read failure never blocks a request — fall through to PG.
    console.warn(`[shared-bars/pg] at-cache read failed for ${key}:`, err);
  }

  const pool = getPgPool();
  const isLive = asOf === undefined;
  // Live anchors the window at `now` (newest unsuperseded bar); as-of anchors it at `asOf`.
  const anchor = isLive ? Date.now() : asOf;

  // Primary window first (the dense steady-state). Expand once on a miss to clear a long pre-asOf
  // hole, but never beyond the bounded wide window.
  let bar = await queryBarInWindow(pool, ticker, interval, anchor, AT_PRIMARY_WINDOW_MS, isLive);
  if (!bar) {
    bar = await queryBarInWindow(pool, ticker, interval, anchor, AT_WIDE_WINDOW_MS, isLive);
  }

  try {
    const payload: CachedBar = { v: 1, cachedAt: Date.now(), bar };
    await redis.setEx(key, CACHE_TTL_SECONDS, JSON.stringify(payload));
  } catch (err) {
    console.warn(`[shared-bars/pg] at-cache write failed for ${key}:`, err);
  }

  return bar;
}

/**
 * Persisted daily-series depth for one ticker on Timescale: `{ oldest, count }` over the UNSUPERSEDED
 * rows (the live series), computed via bounded-window walking so no single query plan spans the whole
 * hypertable (the OOM the card exists to avoid — see DEPTH_WINDOW_MS / the at-or-before regression).
 * `oldest` is the minimum `observation_ts` (UTC ms) or null when the name has no daily bars; `count`
 * is the unsuperseded row total. `floorMs` defaults to the 1990 deep floor; raise it for a shallower
 * (cheaper) probe. No Redis cache: this is an operator depth audit, not a hot path.
 */
export async function getDailyDepthPg(
  ticker: string,
  interval: BarInterval,
  floorMs: number = DEPTH_FLOOR_MS,
): Promise<{ oldest: number | null; count: number }> {
  const pool = getPgPool();
  const nowMs = Date.now();
  const { symbol, market } = identityOf(ticker);
  let oldest: number | null = null;
  let count = 0;
  // Walk forward in bounded windows. Each query is bounded on BOTH sides of the time dimension, so
  // the planner prunes to that window's chunks — never the full hypertable's lock table.
  for (let lo = floorMs; lo < nowMs; lo += DEPTH_WINDOW_MS) {
    const hi = Math.min(lo + DEPTH_WINDOW_MS, nowMs + DAY_MS); // +1d so the newest bar's window is inclusive
    const { rows } = await pool.query<{ n: string; oldest: string | null }>(
      `SELECT count(*)::bigint AS n, min(observation_ts) AS oldest
         FROM bars
        WHERE symbol = $1
          AND market = $2
          AND interval = $3
          AND is_superseded = FALSE
          AND observation_ts >= $4
          AND observation_ts < $5`,
      [symbol, market, interval, lo, hi],
    );
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) {
      count += n;
      if (oldest === null && rows[0]?.oldest != null) oldest = Number(rows[0].oldest);
    }
  }
  return { oldest, count };
}

/**
 * Latest close from Timescale. Convenience wrapper over getBarsFromPg('30d').
 * Pass `opts.asOf` for as-of audits.
 */
export async function getLastClosePg(
  redis: Pick<RedisClientType, 'get' | 'setEx'>,
  ticker: string,
  interval: BarInterval = 'daily',
  opts: GetBarsOpts = {},
): Promise<number | null> {
  const bars = await getBarsFromPg(redis, ticker, interval, '30d', opts);
  const last = bars[bars.length - 1];
  return last ? last.close : null;
}

// PG rows come back with BIGINT columns as strings (node-postgres default behaviour —
// JS numbers can't safely hold values > 2^53, so the driver doesn't auto-coerce).
// Coerce here at the read boundary so consumers see OHLCVBar.observation_ts as a
// number, matching the Mongo reader's contract exactly.
function rowToBar(row: Record<string, unknown>): OHLCVBar {
  const observationMs = Number(row.observation_ts);
  const knowledgeMs   = row.knowledge_ts !== undefined ? Number(row.knowledge_ts) : undefined;
  // Storage is keyed on (symbol, market); re-derive the T212 ticker so OHLCVBar.ticker is identical
  // to what callers pass in (the OHLCVBar contract is unchanged by this card).
  const ticker = tickerOf(String(row.symbol ?? ''), String(row.market ?? ''));

  const bar: OHLCVBar = {
    ticker,
    observation_ts: observationMs,
    // Legacy alias preserved for any consumer still reading `timestamp` —
    // matches the Mongo reader's docToBar so the two backends are read-side
    // indistinguishable.
    timestamp:      observationMs,
    interval:       (row.interval as BarInterval) ?? 'daily',
    open:           Number(row.open   ?? 0),
    high:           Number(row.high   ?? 0),
    low:            Number(row.low    ?? 0),
    close:          Number(row.close  ?? 0),
    volume:         Number(row.volume ?? 0),
  };
  if (knowledgeMs !== undefined && Number.isFinite(knowledgeMs))   bar.knowledge_ts     = knowledgeMs;
  if (typeof row.content_hash    === 'string')                     bar.content_hash     = row.content_hash;
  if (typeof row.is_superseded   === 'boolean')                    bar.is_superseded    = row.is_superseded;
  if (row.raw_close          != null)                              bar.rawClose         = Number(row.raw_close);
  if (row.adjusted_close     != null)                              bar.adjustedClose    = Number(row.adjusted_close);
  if (row.adjustment_factor  != null)                              bar.adjustmentFactor = Number(row.adjustment_factor);
  if (row.currency === 'USD' || row.currency === 'GBP')            bar.currency         = row.currency;
  return bar;
}
