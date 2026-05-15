// shared-bars — read-through bar cache.
//
// Architecture: Mongo `ohlcv_bars` is the source of truth (durable, written by
// market-data-service live polling and the admin backfill endpoint). Redis is a
// pure read cache: SET on miss with TTL, DEL on invalidate. The cache holds the
// already-sorted, fully-deserialized time series for a fixed set of range keys
// (30d/60d/90d/1y) so consumers don't reconstruct it on every call.
//
// Why a fixed range key set instead of arbitrary day counts:
//   - cache hit rate is much higher when the same N keys repeat across consumers
//   - invalidation pattern is simple: `bars:{ticker}:{interval}:*` covers all ranges
//   - a slightly-too-large range is cheaper than re-querying Mongo; consumers can
//     trim the returned array themselves
//
// Consumers: dispatcher drift gate, strategy-engine warmup replay, backtest engine,
// portal historical charts. Each calls getBars; nobody touches ohlcv_bars directly.

import type { Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import type { OHLCVBar, BarInterval } from '@trader/shared-types';
import { COLLECTIONS } from '@trader/shared-mongo';

export type RangeKey = '30d' | '60d' | '90d';

const RANGE_DAYS: Record<RangeKey, number> = {
  '30d': 30,
  '60d': 60,
  '90d': 90,
};

// Bucket size in ms for each interval the consumer might request. Storage is always
// 5m — anything coarser is aggregated on read via aggregateBars below.
const INTERVAL_MS: Record<BarInterval, number> = {
  '5m':   5  * 60_000,
  '15m':  15 * 60_000,
  '1h':   60 * 60_000,
  'daily': 24 * 60 * 60_000,
};

/**
 * Aggregate finer-grained bars into coarser ones. Standard OHLCV aggregation:
 *   open   = first bar's open in the bucket
 *   high   = max of highs
 *   low    = min of lows
 *   close  = last bar's close in the bucket
 *   volume = sum of volumes
 *
 * Bucket boundary is `floor(timestamp / bucketMs) * bucketMs`. For `daily` this aligns
 * to 00:00:00Z; an LSE trading session that runs ~07:00-15:30 UTC and a US session
 * ~14:30-21:00 UTC will both fold into the same UTC day bucket, which matches how the
 * existing strategy treats daily bars.
 *
 * Bars NOT aligned to the bucket size (e.g. weekly aggregation when the bucket spans
 * a market close) are still grouped by UTC-day fold; the strategy treats those as
 * a single "day" of price action.
 */
export function aggregateBars(source: OHLCVBar[], to: BarInterval): OHLCVBar[] {
  if (source.length === 0) return [];
  const fromInterval = source[0].interval ?? '5m';
  if (fromInterval === to) return source;
  const bucketMs = INTERVAL_MS[to];

  const buckets = new Map<number, OHLCVBar[]>();
  for (const b of source) {
    const key = Math.floor(b.timestamp / bucketMs) * bucketMs;
    let list = buckets.get(key);
    if (!list) { list = []; buckets.set(key, list); }
    list.push(b);
  }

  const out: OHLCVBar[] = [];
  const ticker = source[0].ticker;
  for (const [bucketStart, list] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.timestamp - b.timestamp);
    const first = list[0];
    const last  = list[list.length - 1];
    let high = first.high, low = first.low, volume = 0;
    for (const b of list) {
      if (b.high > high) high = b.high;
      if (b.low  < low)  low  = b.low;
      volume += b.volume;
    }
    out.push({
      ticker,
      timestamp: bucketStart,
      interval:  to,
      open:      first.open,
      high,
      low,
      close:     last.close,
      volume,
    });
  }
  return out;
}

const CACHE_TTL_SECONDS = 3600;  // 1h. Backfill/live-write invalidates explicitly anyway.

interface CachedSeries {
  v: 1;                 // schema version — bump if OHLCVBar shape changes incompatibly
  cachedAt: number;
  bars: OHLCVBar[];
}

function cacheKey(ticker: string, interval: BarInterval, range: RangeKey): string {
  return `bars:${ticker}:${interval}:${range}`;
}

function metaKey(ticker: string, interval: BarInterval): string {
  return `bars:meta:${ticker}:${interval}`;
}

/**
 * Read a time-sorted OHLCV series. Tries Redis first; on miss, queries Mongo and
 * populates the cache. Returns oldest-first. Empty array if nothing matches.
 *
 * The returned array is always a fresh copy — callers may mutate it without affecting
 * the cache.
 */
export async function getBars(
  redis: Pick<RedisClientType, 'get' | 'setEx'>,
  db: Db,
  ticker: string,
  interval: BarInterval,
  range: RangeKey,
): Promise<OHLCVBar[]> {
  const key = cacheKey(ticker, interval, range);
  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedSeries;
      if (parsed.v === 1 && Array.isArray(parsed.bars)) return parsed.bars;
    }
  } catch (err) {
    // Cache read failure should never block a request — fall through to Mongo.
    console.warn(`[shared-bars] cache read failed for ${key}:`, err);
  }

  const sinceTs = new Date(Date.now() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000);
  const docs = await db
    .collection(COLLECTIONS.OHLCV_BARS)
    .find({ ticker, interval, timestamp: { $gte: sinceTs } })
    .sort({ timestamp: 1 })
    .toArray();

  const bars: OHLCVBar[] = docs.map(docToBar);

  try {
    const payload: CachedSeries = { v: 1, cachedAt: Date.now(), bars };
    await redis.setEx(key, CACHE_TTL_SECONDS, JSON.stringify(payload));
  } catch (err) {
    console.warn(`[shared-bars] cache write failed for ${key}:`, err);
  }

  return bars;
}

/**
 * Latest close for a ticker at the given interval. Convenience over getBars('30d')
 * for callers that only need the most recent price (e.g. dispatcher drift gate).
 * Returns null if no bars are cached or stored.
 */
export async function getLastClose(
  redis: Pick<RedisClientType, 'get' | 'setEx'>,
  db: Db,
  ticker: string,
  interval: BarInterval = 'daily',
): Promise<number | null> {
  const bars = await getBars(redis, db, ticker, interval, '30d');
  if (bars.length === 0) return null;
  return bars[bars.length - 1].close;
}

/**
 * Drop every cached range for (ticker, interval). Call after any write that could
 * change the underlying series — backfill, live-poll persist, manual edits. Cheap:
 * a SCAN + DEL over at most ~4 keys per (ticker, interval).
 */
export async function invalidateBars(
  redis: RedisClientType,
  ticker: string,
  interval: BarInterval,
): Promise<number> {
  const ranges: RangeKey[] = ['30d', '60d', '90d', '1y'];
  const keys = ranges.map((r) => cacheKey(ticker, interval, r));
  keys.push(metaKey(ticker, interval));
  // del accepts variadic keys; some clients want an array. The node-redis v4 API
  // takes either — we spread to be safe across versions.
  let removed = 0;
  for (const k of keys) {
    try { removed += await redis.del(k); } catch { /* skip */ }
  }
  return removed;
}

/**
 * Bulk invalidation: drop cached ranges for an entire universe at once. Used by the
 * admin backfill endpoint after it writes a batch — one call per ticker would do but
 * grouping reduces round-trips.
 */
export async function invalidateBarsBulk(
  redis: RedisClientType,
  entries: Array<{ ticker: string; interval: BarInterval }>,
): Promise<number> {
  let total = 0;
  for (const e of entries) total += await invalidateBars(redis, e.ticker, e.interval);
  return total;
}

// ---- internal ----

function docToBar(doc: Record<string, unknown>): OHLCVBar {
  const ts = doc.timestamp;
  const tsMs = ts instanceof Date ? ts.getTime() : typeof ts === 'number' ? ts : 0;
  return {
    ticker:           String(doc.ticker ?? ''),
    timestamp:        tsMs,
    interval:         (doc.interval as BarInterval) ?? 'daily',
    open:             Number(doc.open  ?? 0),
    high:             Number(doc.high  ?? 0),
    low:              Number(doc.low   ?? 0),
    close:            Number(doc.close ?? 0),
    volume:           Number(doc.volume ?? 0),
    rawClose:         typeof doc.rawClose === 'number' ? doc.rawClose : undefined,
    adjustedClose:    typeof doc.adjustedClose === 'number' ? doc.adjustedClose : undefined,
    adjustmentFactor: typeof doc.adjustmentFactor === 'number' ? doc.adjustmentFactor : undefined,
  };
}
