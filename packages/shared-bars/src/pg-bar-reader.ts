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

import type { RedisClientType } from 'redis';
import type { OHLCVBar, BarInterval } from '@trader/shared-types';
import { getPgPool } from '@trader/shared-pg';

import type { GetBarsOpts, RangeKey } from './index.ts';

const RANGE_DAYS: Record<RangeKey, number> = {
  '30d': 30,
  '60d': 60,
  '90d': 90,
  '180d': 180,
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
