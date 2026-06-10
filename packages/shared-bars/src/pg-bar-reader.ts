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
import { getPgPool } from '@trader/shared-pg';

import type { GetBarsOpts, RangeKey } from './index.ts';

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
  return `bars:pg:v1:${ticker}:${interval}:${range}:${asOfBucket(asOf)}`;
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

  let bars: OHLCVBar[];
  if (asOf === undefined) {
    // Live path — partial-unique index fast lane. `is_superseded = FALSE` picks
    // exactly one row per (ticker, observation_ts, interval).
    const { rows } = await pool.query(
      `SELECT ticker, observation_ts, knowledge_ts, interval,
              open, high, low, close, volume,
              raw_close, adjusted_close, adjustment_factor,
              currency, content_hash, is_superseded
         FROM bars
        WHERE ticker = $1
          AND interval = $2
          AND is_superseded = FALSE
          AND observation_ts >= $3
        ORDER BY observation_ts ASC`,
      [ticker, interval, sinceTs],
    );
    bars = rows.map(rowToBar);
  } else {
    // As-of path — `DISTINCT ON (observation_ts) ... ORDER BY observation_ts ASC,
    // knowledge_ts DESC` is the PG-native equivalent of Mongo's
    // `$sort+$group({$first})`. The bars_knowledge_lookup index covers the range.
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (observation_ts)
              ticker, observation_ts, knowledge_ts, interval,
              open, high, low, close, volume,
              raw_close, adjusted_close, adjustment_factor,
              currency, content_hash, is_superseded
         FROM bars
        WHERE ticker = $1
          AND interval = $2
          AND observation_ts >= $3
          AND knowledge_ts <= $4
        ORDER BY observation_ts ASC, knowledge_ts DESC`,
      [ticker, interval, sinceTs, asOf],
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

/**
 * Cache key for the single-bar at-or-before read. Distinct `:at:` segment so it never
 * collides with the windowed-series keys (`pgCacheKey`) — a series read and a single-bar
 * read for the same (ticker, interval, asOf) are different shapes.
 */
export function pgAtCacheKey(ticker: string, interval: BarInterval, asOf?: number): string {
  return `bars:pg:v1:${ticker}:${interval}:at:${asOfBucket(asOf)}`;
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
  const sql = isLive
    ? `SELECT ticker, observation_ts, knowledge_ts, interval,
              open, high, low, close, volume,
              raw_close, adjusted_close, adjustment_factor,
              currency, content_hash, is_superseded
         FROM bars
        WHERE ticker = $1
          AND interval = $2
          AND is_superseded = FALSE
          AND observation_ts <= $3
          AND observation_ts > $4
        ORDER BY observation_ts DESC
        LIMIT 1`
    : `SELECT ticker, observation_ts, knowledge_ts, interval,
              open, high, low, close, volume,
              raw_close, adjusted_close, adjustment_factor,
              currency, content_hash, is_superseded
         FROM bars
        WHERE ticker = $1
          AND interval = $2
          AND observation_ts <= $3
          AND observation_ts > $4
          AND knowledge_ts <= $3
        ORDER BY observation_ts DESC, knowledge_ts DESC
        LIMIT 1`;
  const { rows } = await pool.query(sql, [ticker, interval, anchor, lowerBound]);
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

  const bar: OHLCVBar = {
    ticker:         String(row.ticker ?? ''),
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
