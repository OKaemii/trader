// shared-bars — read-through bar cache.
//
// Architecture: Mongo `ohlcv_bars` is the source of truth (durable, written by
// market-data-service live polling and the admin backfill endpoint). Redis is a
// pure read cache: SET on miss with TTL, DEL on invalidate. The cache holds the
// already-sorted, fully-deserialized time series for a fixed set of range keys
// (30d/60d/90d/180d) so consumers don't reconstruct it on every call.
//
// Bi-temporal storage: every row carries an `observation_ts` (wall-clock instant
// the bar describes) and a `knowledge_ts` (wall-clock instant the row was written).
// Live reads filter to `is_superseded:false`, which selects exactly one row per
// (ticker, observation_ts, interval) via a partial unique index. As-of reads pass
// `asOf` (a knowledge_ts upper bound), bypass the partial index, and aggregate to
// pick the latest revision known at that time. See
// agent-docs/plans/point-in-time-bar-history.md.
//
// Why a fixed range key set instead of arbitrary day counts:
//   - cache hit rate is much higher when the same N keys repeat across consumers
//   - invalidation pattern is simple: `bars:v2:{ticker}:{interval}:*` covers all ranges
//   - a slightly-too-large range is cheaper than re-querying Mongo; consumers can
//     trim the returned array themselves
//
// Consumers: dispatcher drift gate, strategy-engine warmup replay, backtest engine,
// portal historical charts. Each calls getBars; nobody touches ohlcv_bars directly.

import type { Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import type { OHLCVBar, BarInterval } from '@trader/shared-types';
import { COLLECTIONS } from '@trader/shared-mongo';
import { getPgPool } from '@trader/shared-pg';
import { getBarsFromPg, getBarAtOrBeforePg, pgCacheKey, pgAtCacheKey } from './pg-bar-reader.ts';

export { hashBarContent } from './content-hash.ts';
export { getBarsFromPg, getBarAtOrBeforePg, getLastClosePg, pgCacheKey, pgAtCacheKey } from './pg-bar-reader.ts';
export { computeMissingRanges, coverageOf } from './coverage.ts';
export type { MissingRange } from './coverage.ts';

// Short keys (30d–180d) bound 5m-derived reads; the long keys (1y–max) exist for the
// persisted `interval:'daily'` series that backs strategy lookbacks (e.g. 12-1 momentum
// needs ~273 trading days). `max` is a sentinel that predates any stored row.
export type RangeKey = '30d' | '60d' | '90d' | '180d' | '1y' | '2y' | '5y' | 'max';

// Exported so the gap-aware coverage helper (coverage.ts) derives the same read window
// getBars uses — one source of truth for how many days each RangeKey spans.
export const RANGE_DAYS: Record<RangeKey, number> = {
  '30d': 30,
  '60d': 60,
  '90d': 90,
  '180d': 180,
  '1y': 365,
  '2y': 730,
  '5y': 1825,
  'max': 36500,
};

// Bucket size in ms for each *fixed-width* interval. Storage is always 5m (intraday) or
// daily (long horizons) — anything coarser is aggregated on read via aggregateBars below.
// 'weekly' is deliberately absent: a fixed 7-day ms width floored from the Unix epoch
// would anchor weeks to the epoch's weekday (a Thursday), mislabelling every weekly bar.
// Weekly is ISO-week-bucketed via weekStartUtc instead.
const INTERVAL_MS: Record<Exclude<BarInterval, 'weekly'>, number> = {
  '5m':   5  * 60_000,
  '15m':  15 * 60_000,
  '1h':   60 * 60_000,
  '4h':   4  * 60 * 60_000,
  'daily': 24 * 60 * 60_000,
};

/**
 * Start of the ISO week (Monday 00:00:00 UTC) that contains `ts`. The anchor for weekly
 * bar aggregation. A naive `floor(ts / 604_800_000) * 604_800_000` would anchor to the
 * Unix epoch's Thursday, so every weekly bucket would start mid-week — hence this helper.
 */
export function weekStartUtc(ts: number): number {
  const d = new Date(ts);
  const dow = (d.getUTCDay() + 6) % 7;            // Mon=0, Tue=1, … Sun=6
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
}

/**
 * Aggregate finer-grained bars into coarser ones. Standard OHLCV aggregation:
 *   open   = first bar's open in the bucket
 *   high   = max of highs
 *   low    = min of lows
 *   close  = last bar's close in the bucket
 *   volume = sum of volumes
 *
 * Bucket boundary is `floor(observation_ts / bucketMs) * bucketMs`. For `daily` this
 * aligns to 00:00:00Z; an LSE trading session that runs ~07:00-15:30 UTC and a US
 * session ~14:30-21:00 UTC will both fold into the same UTC day bucket, which matches
 * how the existing strategy treats daily bars.
 */
export function aggregateBars(source: OHLCVBar[], to: BarInterval): OHLCVBar[] {
  const head = source[0];
  if (!head) return [];
  const fromInterval = head.interval ?? '5m';
  if (fromInterval === to) return source;

  // Weekly buckets by ISO week (Monday-anchored); every other target is a fixed-width
  // floor. Keeping weekly out of INTERVAL_MS means we never index it with `undefined`.
  const bucketOf = to === 'weekly'
    ? weekStartUtc
    : (ts: number) => { const m = INTERVAL_MS[to]; return Math.floor(ts / m) * m; };

  const buckets = new Map<number, OHLCVBar[]>();
  for (const b of source) {
    const key = bucketOf(b.observation_ts);
    let list = buckets.get(key);
    if (!list) { list = []; buckets.set(key, list); }
    list.push(b);
  }

  const out: OHLCVBar[] = [];
  const ticker = head.ticker;
  for (const [bucketStart, list] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.observation_ts - b.observation_ts);
    const first = list[0];
    const last  = list[list.length - 1];
    if (!first || !last) continue;
    let high = first.high, low = first.low, volume = 0;
    for (const b of list) {
      if (b.high > high) high = b.high;
      if (b.low  < low)  low  = b.low;
      volume += b.volume;
    }
    out.push({
      ticker,
      observation_ts: bucketStart,
      // Legacy alias for downstream consumers still reading `timestamp`. Removed in the
      // major schema bump that retires the deprecated field.
      timestamp:      bucketStart,
      interval:       to,
      open:           first.open,
      high,
      low,
      close:          last.close,
      volume,
    });
  }
  return out;
}

const CACHE_TTL_SECONDS = 3600;  // 1h. Backfill/live-write invalidates explicitly anyway.

interface CachedSeries {
  v: 2;                 // schema version — bumped from 1 to 2 with the bi-temporal asOf bucket.
  cachedAt: number;
  bars: OHLCVBar[];
}

// Single-bar cache (getBarAtOrBefore). Distinct shape from CachedSeries — a single bar (or null),
// keyed under a distinct `:at:` segment so it never collides with the windowed-series entries.
interface CachedBar {
  v: 2;
  cachedAt: number;
  bar: OHLCVBar | null;
}

// 60s buckets. Live readers all want "now" ± a few seconds, and a 60s bucket keeps
// cache hit rate high without serving more than a minute of stale data. Backtests
// pass exact asOf values (wall-clock minutes from a replay clock) that fall on aligned
// boundaries, so the bucketing matches them too.
function asOfBucket(asOf: number | undefined): string {
  if (asOf === undefined) return 'live';
  return String(Math.floor(asOf / 60_000));
}

function cacheKey(ticker: string, interval: BarInterval, range: RangeKey, asOf?: number): string {
  return `bars:v2:${ticker}:${interval}:${range}:${asOfBucket(asOf)}`;
}

function atCacheKey(ticker: string, interval: BarInterval, asOf?: number): string {
  return `bars:v2:${ticker}:${interval}:at:${asOfBucket(asOf)}`;
}

function metaKey(ticker: string, interval: BarInterval): string {
  return `bars:v2:meta:${ticker}:${interval}`;
}

export interface GetBarsOpts {
  /**
   * Knowledge-time cutoff. When set, returns the latest revision of each
   * observation_ts whose knowledge_ts <= asOf. Omitting `asOf` is equivalent to
   * "as of now" — the live-read fast path that hits the partial-unique index
   * filtered by `is_superseded:false`.
   */
  asOf?: number;
}

/**
 * Which physical store backs bar reads. Defaults to `mongo` so existing callers
 * keep working unchanged; flip to `timescale` (Helm values, no code change) once
 * the dual-write window has converged. Read fresh on every call so a single
 * process can be re-pointed without restart (relevant during cutover validation).
 *
 * See agent-docs/plans/three-database-split.md §Cutover.
 */
function activeBackend(): 'mongo' | 'timescale' {
  return (process.env.BARS_BACKEND ?? 'mongo') === 'timescale' ? 'timescale' : 'mongo';
}

/**
 * Read a time-sorted OHLCV series. Tries Redis first; on miss, queries the active
 * backend (Mongo or Timescale per `BARS_BACKEND`) and populates the cache. Returns
 * oldest-first. Empty array if nothing matches.
 *
 * The returned array is always a fresh copy — callers may mutate it without affecting
 * the cache.
 *
 * @param db  MongoDB handle. Required when `BARS_BACKEND=mongo` (the default);
 *           may be `undefined` when `BARS_BACKEND=timescale`. The two-arg shape
 *           preserves the existing call sites verbatim during the cutover.
 */
export async function getBars(
  redis: Pick<RedisClientType, 'get' | 'setEx'>,
  db: Db | undefined,
  ticker: string,
  interval: BarInterval,
  range: RangeKey,
  opts: GetBarsOpts = {},
): Promise<OHLCVBar[]> {
  if (activeBackend() === 'timescale') {
    return getBarsFromPg(redis, ticker, interval, range, opts);
  }
  if (!db) {
    throw new Error('[shared-bars] getBars: db parameter required when BARS_BACKEND=mongo (the default)');
  }
  return getBarsFromMongo(redis, db, ticker, interval, range, opts);
}

async function getBarsFromMongo(
  redis: Pick<RedisClientType, 'get' | 'setEx'>,
  db: Db,
  ticker: string,
  interval: BarInterval,
  range: RangeKey,
  opts: GetBarsOpts,
): Promise<OHLCVBar[]> {
  const asOf = opts.asOf;
  const key = cacheKey(ticker, interval, range, asOf);
  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedSeries;
      if (parsed.v === 2 && Array.isArray(parsed.bars)) return parsed.bars;
    }
  } catch (err) {
    // Cache read failure should never block a request — fall through to Mongo.
    console.warn(`[shared-bars] cache read failed for ${key}:`, err);
  }

  const sinceTs = Date.now() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000;
  const coll = db.collection(COLLECTIONS.OHLCV_BARS);

  let bars: OHLCVBar[];
  if (asOf === undefined) {
    // Live path — partial-index fast lane. is_superseded:false picks exactly one row
    // per (ticker, observation_ts, interval). observation_ts:{$gte} bounds the range.
    const docs = await coll
      .find({ ticker, interval, is_superseded: false, observation_ts: { $gte: sinceTs } })
      .sort({ observation_ts: 1 })
      .toArray();
    bars = docs.map(docToBar);
  } else {
    // As-of path — one bar per observation_ts, picking the latest revision known at asOf.
    // The compound (ticker, observation_ts, interval, knowledge_ts) index covers the
    // match; $sort+$group selects per-observation-ts.
    const docs = await coll.aggregate([
      { $match: {
          ticker,
          interval,
          observation_ts: { $gte: sinceTs },
          knowledge_ts:   { $lte: asOf },
      } },
      { $sort: { observation_ts: 1, knowledge_ts: -1 } },
      { $group: { _id: '$observation_ts', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { observation_ts: 1 } },
    ]).toArray();
    bars = docs.map(docToBar);
  }

  try {
    const payload: CachedSeries = { v: 2, cachedAt: Date.now(), bars };
    await redis.setEx(key, CACHE_TTL_SECONDS, JSON.stringify(payload));
  } catch (err) {
    console.warn(`[shared-bars] cache write failed for ${key}:`, err);
  }

  return bars;
}

/**
 * The single latest bar at/<= a knowledge instant (or the latest bar live), dispatching to the
 * active backend per `BARS_BACKEND`. Returns `null` when none qualifies.
 *
 * This is the OOM-safe read the PIT market-cap / dividend-yield enrichment uses INSTEAD of
 * `getBars(..., 'max', { asOf })`: it never carries a now-anchored lower bound, so a deep
 * historical as-of and 'now' both touch one row via a `DESC … LIMIT 1` index seek (the old
 * `range='max'` lower-bound scan matched every chunk back to ~1926 → Timescale lock-table
 * exhaustion → "out of shared memory" → a 500 to the caller). The live windowed strategy reads
 * are untouched — this is an additive read used only by enrichment.
 *
 * @param db  MongoDB handle. Required when `BARS_BACKEND=mongo` (the default); may be `undefined`
 *           when `BARS_BACKEND=timescale`.
 */
export async function getBarAtOrBefore(
  redis: Pick<RedisClientType, 'get' | 'setEx'>,
  db: Db | undefined,
  ticker: string,
  interval: BarInterval,
  opts: GetBarsOpts = {},
): Promise<OHLCVBar | null> {
  if (activeBackend() === 'timescale') {
    return getBarAtOrBeforePg(redis, ticker, interval, opts);
  }
  if (!db) {
    throw new Error('[shared-bars] getBarAtOrBefore: db parameter required when BARS_BACKEND=mongo (the default)');
  }
  return getBarAtOrBeforeFromMongo(redis, db, ticker, interval, opts);
}

async function getBarAtOrBeforeFromMongo(
  redis: Pick<RedisClientType, 'get' | 'setEx'>,
  db: Db,
  ticker: string,
  interval: BarInterval,
  opts: GetBarsOpts,
): Promise<OHLCVBar | null> {
  const asOf = opts.asOf;
  const key = atCacheKey(ticker, interval, asOf);
  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedBar;
      if (parsed.v === 2 && 'bar' in parsed) return parsed.bar;
    }
  } catch (err) {
    console.warn(`[shared-bars] at-cache read failed for ${key}:`, err);
  }

  const coll = db.collection(COLLECTIONS.OHLCV_BARS);

  let bar: OHLCVBar | null;
  if (asOf === undefined) {
    // Live path — partial-index fast lane. Newest unsuperseded bar; no lower bound.
    const docs = await coll
      .find({ ticker, interval, is_superseded: false })
      .sort({ observation_ts: -1 })
      .limit(1)
      .toArray();
    bar = docs[0] ? docToBar(docs[0]) : null;
  } else {
    // As-of path — newest observation_ts at/<= asOf, then its latest revision known by asOf.
    // $sort observation_ts DESC, knowledge_ts DESC → $group picks the first (latest revision) per
    // observation_ts → $sort DESC → LIMIT 1 takes the newest observation. Mirrors the PG
    // DISTINCT ON … LIMIT 1 shape.
    const docs = await coll.aggregate([
      { $match: {
          ticker,
          interval,
          observation_ts: { $lte: asOf },
          knowledge_ts:   { $lte: asOf },
      } },
      { $sort: { observation_ts: -1, knowledge_ts: -1 } },
      { $group: { _id: '$observation_ts', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { observation_ts: -1 } },
      { $limit: 1 },
    ]).toArray();
    bar = docs[0] ? docToBar(docs[0]) : null;
  }

  try {
    const payload: CachedBar = { v: 2, cachedAt: Date.now(), bar };
    await redis.setEx(key, CACHE_TTL_SECONDS, JSON.stringify(payload));
  } catch (err) {
    console.warn(`[shared-bars] at-cache write failed for ${key}:`, err);
  }

  return bar;
}

/**
 * Latest close for a ticker at the given interval. Convenience over getBars('30d')
 * for callers that only need the most recent price (e.g. dispatcher drift gate).
 * Returns null if no bars are cached or stored. Pass `opts.asOf` to ask "what was
 * the last close known at this knowledge time?".
 */
export async function getLastClose(
  redis: Pick<RedisClientType, 'get' | 'setEx'>,
  db: Db | undefined,
  ticker: string,
  interval: BarInterval = 'daily',
  opts: GetBarsOpts = {},
): Promise<number | null> {
  const bars = await getBars(redis, db, ticker, interval, '30d', opts);
  const last = bars[bars.length - 1];
  return last ? last.close : null;
}

export interface MidQuote {
  mid: number;
  source: string;
  spread_bps: number | null;
  staleness_ms: number;
  observation_ts: number;
}

/**
 * Latest unsuperseded mid-quote for a ticker within a freshness window (Timescale `quotes`,
 * populated by market-data-service's quote poll). Returns null when no quote is fresh enough —
 * callers (drift gate, TCA) fall back to last-close. `asOf` reads as-of a knowledge instant for
 * TCA's arrival/fill lookups; defaults to now.
 */
export async function getMidQuote(
  ticker: string,
  opts: { freshnessMs?: number; asOf?: number } = {},
): Promise<MidQuote | null> {
  const freshness = opts.freshnessMs ?? 15 * 60_000;
  const asOf = opts.asOf ?? Date.now();
  const pool = getPgPool();
  const { rows } = await pool.query<{ mid: number; source: string; spread_bps: number | null; observation_ts: string }>(
    `SELECT mid, source, spread_bps, observation_ts FROM quotes
     WHERE ticker = $1 AND is_superseded = FALSE AND observation_ts <= $2
     ORDER BY observation_ts DESC LIMIT 1`,
    [ticker, asOf],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  const observationTs = Number(r.observation_ts);
  const staleness = asOf - observationTs;
  if (staleness > freshness) return null;
  return {
    mid: Number(r.mid),
    source: r.source,
    spread_bps: r.spread_bps != null ? Number(r.spread_bps) : null,
    staleness_ms: staleness,
    observation_ts: observationTs,
  };
}

/**
 * Drop every cached range for (ticker, interval). Call after any write that could
 * change the underlying series — backfill, live-poll persist, manual edits. Cheap:
 * a SCAN + DEL over at most ~4 keys per (ticker, interval).
 *
 * Note: bi-temporal cache keys also vary by `asOfBucket`. Live readers all share the
 * `live` bucket, which is what we DEL. As-of readers (backtest, audit) use minute-
 * resolution buckets that decay naturally (1h TTL) and don't need explicit
 * invalidation — their asOf is by definition in the past, so a new write doesn't
 * change what they should see.
 */
export async function invalidateBars(
  redis: RedisClientType,
  ticker: string,
  interval: BarInterval,
): Promise<number> {
  const ranges = Object.keys(RANGE_DAYS) as RangeKey[];
  // Clear both namespaces unconditionally — during the dual-write window both
  // caches may be populated, and after cutover the inactive one is just absent
  // (the DEL is a cheap no-op). Sidesteps the alternative of having to know
  // which backend is active inside the invalidator.
  const keys: string[] = [];
  for (const r of ranges) {
    keys.push(cacheKey(ticker, interval, r));
    keys.push(pgCacheKey(ticker, interval, r));
  }
  // The single-bar at-or-before live caches (Mongo + PG namespaces) — the live bucket only; as-of
  // buckets are minute-resolution and decay on their 1h TTL (their asOf is in the past, so a new
  // write doesn't change what they should return).
  keys.push(atCacheKey(ticker, interval));
  keys.push(pgAtCacheKey(ticker, interval));
  keys.push(metaKey(ticker, interval));
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

// Reads both the new bi-temporal shape (observation_ts as number) and the legacy
// pre-migration shape (timestamp as Date). Once the migration has backfilled every
// row, the `timestamp instanceof Date` branch is dead — kept for the migration
// window only.
function docToBar(doc: Record<string, unknown>): OHLCVBar {
  const obsTs = doc.observation_ts;
  let observationMs: number;
  if (typeof obsTs === 'number') {
    observationMs = obsTs;
  } else {
    const legacy = doc.timestamp;
    observationMs = legacy instanceof Date ? legacy.getTime() : typeof legacy === 'number' ? legacy : 0;
  }
  const knowledgeMs = typeof doc.knowledge_ts === 'number' ? doc.knowledge_ts : undefined;

  const bar: OHLCVBar = {
    ticker:         String(doc.ticker ?? ''),
    observation_ts: observationMs,
    // Carry the legacy alias for any consumer that hasn't migrated yet. Removed when
    // the deprecation window closes.
    timestamp:      observationMs,
    interval:       (doc.interval as BarInterval) ?? 'daily',
    open:           Number(doc.open   ?? 0),
    high:           Number(doc.high   ?? 0),
    low:            Number(doc.low    ?? 0),
    close:          Number(doc.close  ?? 0),
    volume:         Number(doc.volume ?? 0),
  };
  if (knowledgeMs !== undefined)                          bar.knowledge_ts     = knowledgeMs;
  if (typeof doc.content_hash      === 'string')          bar.content_hash     = doc.content_hash;
  if (typeof doc.is_superseded     === 'boolean')         bar.is_superseded    = doc.is_superseded;
  if (typeof doc.rawClose          === 'number')          bar.rawClose         = doc.rawClose;
  if (typeof doc.adjustedClose     === 'number')          bar.adjustedClose    = doc.adjustedClose;
  if (typeof doc.adjustmentFactor  === 'number')          bar.adjustmentFactor = doc.adjustmentFactor;
  if (doc.currency === 'USD' || doc.currency === 'GBP')   bar.currency         = doc.currency;
  return bar;
}
