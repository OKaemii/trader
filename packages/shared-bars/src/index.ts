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
import type { TickerIdentity } from '@trader/ticker-identity';
import { COLLECTIONS } from '@trader/shared-mongo';
import { getPgPool } from '@trader/shared-pg';
import {
  getBarsFromPg, getBarAtOrBeforePg, getDailyDepthPg, getRecentBarsForTickersPg,
  getObservedTimestampsPg, countBarsForTickersPg, countAllBarsPg, latestObservationForTickersPg,
  countRevisionsForTickersPg, getRevisionsForTickerPg,
  pgCacheKey, pgAtCacheKey,
} from './pg-bar-reader.ts';
import type { BarRevisionLogRow } from './pg-bar-reader.ts';
import { identityOf, tickerOf, identityKey } from './identity.ts';

export { hashBarContent } from './content-hash.ts';
export {
  getBarsFromPg, getBarAtOrBeforePg, getDailyDepthPg, getRecentBarsForTickersPg,
  getObservedTimestampsPg, countBarsForTickersPg, countAllBarsPg, latestObservationForTickersPg,
  countRevisionsForTickersPg, getRevisionsForTickerPg, type BarRevisionLogRow,
  getLastClosePg, pgCacheKey, pgAtCacheKey,
} from './pg-bar-reader.ts';
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

// Cache keys carry the bare identity (`${symbol}:${market}`) — not the T212 ticker — so two markets
// listing the same symbol never share an entry. The ticker is split via the adapter at the boundary.
function cacheKey(ticker: string, interval: BarInterval, range: RangeKey, asOf?: number): string {
  const id = identityOf(ticker);
  return `bars:v2:${identityKey(id.symbol, id.market)}:${interval}:${range}:${asOfBucket(asOf)}`;
}

function atCacheKey(ticker: string, interval: BarInterval, asOf?: number): string {
  const id = identityOf(ticker);
  return `bars:v2:${identityKey(id.symbol, id.market)}:${interval}:at:${asOfBucket(asOf)}`;
}

// at-or-before window bounds (ms). The single-bar read is bounded BELOW at the anchor (`asOf`, or
// `now` for live) so the two backends share one semantics: the latest bar within the window, the
// dense steady-state served by the primary, a long pre-asOf hole cleared by the one wider fallback.
// This bound is load-bearing on Timescale (it stops the per-chunk lock fan that exhausted the lock
// table on a deep daily series → "out of shared memory"; see pg-bar-reader.ts); on Mongo it keeps
// the result identical across `BARS_BACKEND`. Mirrors AT_PRIMARY_WINDOW_MS / AT_WIDE_WINDOW_MS there.
const AT_DAY_MS = 24 * 60 * 60 * 1000;
const AT_PRIMARY_WINDOW_MS = 400 * AT_DAY_MS;
const AT_WIDE_WINDOW_MS = 5 * 365 * AT_DAY_MS;

function metaKey(ticker: string, interval: BarInterval): string {
  const id = identityOf(ticker);
  return `bars:v2:meta:${identityKey(id.symbol, id.market)}:${interval}`;
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
  const { symbol, market } = identityOf(ticker);

  let bars: OHLCVBar[];
  if (asOf === undefined) {
    // Live path — partial-index fast lane. is_superseded:false picks exactly one row
    // per (symbol, market, observation_ts, interval). observation_ts:{$gte} bounds the range.
    const docs = await coll
      .find({ symbol, market, interval, is_superseded: false, observation_ts: { $gte: sinceTs } })
      .sort({ observation_ts: 1 })
      .toArray();
    bars = docs.map(docToBar);
  } else {
    // As-of path — one bar per observation_ts, picking the latest revision known at asOf.
    // The compound (symbol, market, observation_ts, interval, knowledge_ts) index covers the
    // match; $sort+$group selects per-observation-ts.
    const docs = await coll.aggregate([
      { $match: {
          symbol,
          market,
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

export interface RecentBarsQuery {
  /** Bar granularity to read (storage interval — `'5m'` for the daily-emit's intraday fold). */
  interval: BarInterval;
  /** Lower bound (UTC ms, inclusive) on `observation_ts`. The load-bearing read-bound. */
  sinceTs: number;
}

/**
 * Latest unsuperseded `interval` bars at/after `sinceTs` for a SET of (symbol, market) identities,
 * dispatched per `BARS_BACKEND`. This is the multi-ticker companion to `getBars` (which is
 * per-ticker, range-keyed): one read over a whole identity set, the shape the daily-emit fold needs
 * ("every active-universe ticker's 5m bars since UTC-midnight"). None of the existing readers fit —
 * `getBars` is one ticker, `getBarAtOrBefore`/`getDailyDepth` are single-purpose bounded reads.
 *
 * Bounded by `observation_ts >= sinceTs` so the Timescale plan stays pruned to the day's chunks (the
 * OOM-safe rule — see getRecentBarsForTickersPg / getBarAtOrBefore). The Mongo branch is the same
 * `{ $or: [{symbol, market}…], interval, is_superseded:false, observation_ts:{$gte} }` query the
 * daily-emit ran inline, lifted here so both stores share one dispatch and one row shape.
 *
 * Unlike the windowed/series readers this read is NOT Redis-cached: the emit calls it once per cycle
 * with a moving "today" window over the whole universe, so a (set, sinceTs)-keyed entry would miss
 * every cycle. Returns OHLCVBar[] oldest-first with the T212 `ticker` re-derived per row; empty array
 * when `ids` is empty or nothing matches.
 *
 * @param db  MongoDB handle. Required when `BARS_BACKEND=mongo` (the default); may be `undefined`
 *           when `BARS_BACKEND=timescale`.
 */
export async function getRecentBarsForTickers(
  _redis: Pick<RedisClientType, 'get' | 'setEx'>,
  db: Db | undefined,
  ids: ReadonlyArray<TickerIdentity>,
  q: RecentBarsQuery,
): Promise<OHLCVBar[]> {
  if (ids.length === 0) return [];
  if (activeBackend() === 'timescale') {
    return getRecentBarsForTickersPg(ids, q);
  }
  if (!db) {
    throw new Error('[shared-bars] getRecentBarsForTickers: db parameter required when BARS_BACKEND=mongo (the default)');
  }
  // Mongo branch — the lifted daily-emit query. Storage is keyed on the bare identity, so the set is
  // matched as an `$or` over (symbol, market); `is_superseded:false` picks the live revision per
  // (symbol, market, observation_ts) via the partial-unique index; `observation_ts:$gte` bounds it.
  const coll = db.collection(COLLECTIONS.OHLCV_BARS);
  const docs = await coll
    .find({
      $or:            ids.map((id) => ({ symbol: id.symbol, market: id.market })),
      interval:       q.interval,
      is_superseded:  false,
      observation_ts: { $gte: q.sinceTs },
    })
    .sort({ observation_ts: 1 })
    .toArray();
  return docs.map(docToBar);
}

// ── Coverage / gap-detection reads, BARS_BACKEND-dispatched ─────────────────────────────────────
// These are the maintenance reads (gap planning, bootstrap-coverage counts, heal latest-bar, the
// admin /coverage + /revisions surfaces) that MUST read the SAME store the writer writes to. Before
// the writer flip they read Mongo directly at their call sites (correct while the writer was
// Mongo-primary); they move here, dispatched, so when BARS_BACKEND=timescale they reflect Timescale —
// otherwise the writer would land bars in Timescale while gap-detection counted Mongo (0 rows post-
// wipe) and re-fetched the whole universe. Each carries a `sinceMs` floor on the Timescale path for
// the same OOM-safe reason every PG read here does (an unbounded aggregate over a deep daily hypertable
// locks every chunk → "out of shared memory"); the Mongo branch keeps the exact prior query.

/**
 * Observed unsuperseded `observation_ts` values for ONE ticker in `[sinceMs, untilMs]`, dispatched per
 * `BARS_BACKEND`. The gap-aware fetch planner diffs these against the step grid. The window bounds it
 * on both sides (OOM-safe on Timescale; identical result on Mongo).
 *
 * @param db  MongoDB handle. Required when `BARS_BACKEND=mongo` (the default); may be `undefined`
 *           when `BARS_BACKEND=timescale`.
 */
export async function getObservedTimestamps(
  db: Db | undefined,
  ticker: string,
  interval: BarInterval,
  sinceMs: number,
  untilMs: number,
): Promise<number[]> {
  if (activeBackend() === 'timescale') {
    return getObservedTimestampsPg(ticker, interval, sinceMs, untilMs);
  }
  if (!db) {
    throw new Error('[shared-bars] getObservedTimestamps: db parameter required when BARS_BACKEND=mongo (the default)');
  }
  const { symbol, market } = identityOf(ticker);
  const docs = await db
    .collection(COLLECTIONS.OHLCV_BARS)
    .find(
      { symbol, market, interval, is_superseded: false, observation_ts: { $gte: sinceMs, $lte: untilMs } },
      { projection: { _id: 0, observation_ts: 1 } },
    )
    .toArray();
  const out: number[] = [];
  for (const d of docs) {
    const ts = (d as { observation_ts?: unknown }).observation_ts;
    if (typeof ts === 'number') out.push(ts);
  }
  return out;
}

/**
 * Unsuperseded `interval` bar count per (symbol, market) for a SET of identities, dispatched per
 * `BARS_BACKEND`, bounded below by `sinceMs`. Returns a Map keyed `${symbol}|${market}` (absent ⇒ 0).
 * Backs the bootstrap-coverage checks + admin `/coverage` count. `sinceMs` is the OOM-safe floor on
 * Timescale — pass a window covering the caller's `minBars` threshold, never the whole hypertable.
 *
 * @param db  MongoDB handle. Required when `BARS_BACKEND=mongo` (the default); may be `undefined`
 *           when `BARS_BACKEND=timescale`.
 */
export async function countBarsForTickers(
  db: Db | undefined,
  ids: ReadonlyArray<TickerIdentity>,
  interval: BarInterval,
  sinceMs: number,
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  if (activeBackend() === 'timescale') {
    return countBarsForTickersPg(ids, interval, sinceMs);
  }
  if (!db) {
    throw new Error('[shared-bars] countBarsForTickers: db parameter required when BARS_BACKEND=mongo (the default)');
  }
  const rows = await db.collection(COLLECTIONS.OHLCV_BARS).aggregate([
    { $match: { $or: ids.map((id) => ({ symbol: id.symbol, market: id.market })), interval, is_superseded: false, observation_ts: { $gte: sinceMs } } },
    { $group: { _id: { symbol: '$symbol', market: '$market' }, count: { $sum: 1 } } },
  ]).toArray();
  const out = new Map<string, number>();
  for (const row of rows as Array<{ _id: { symbol: string; market: string }; count: number }>) {
    out.set(`${row._id.symbol}|${row._id.market}`, row.count ?? 0);
  }
  return out;
}

/**
 * Unsuperseded `interval` bar count per (symbol, market) across the WHOLE store (every name with bars,
 * not a fixed set), dispatched per `BARS_BACKEND`, bounded below by `sinceMs`. Returns a Map keyed
 * `${symbol}|${market}`. Backs the admin `/coverage` endpoint. `sinceMs` is the OOM-safe floor on
 * Timescale (pass the interval's natural window — 5m: ~the 60d provider cap).
 *
 * @param db  MongoDB handle. Required when `BARS_BACKEND=mongo` (the default); may be `undefined`
 *           when `BARS_BACKEND=timescale`.
 */
export async function countAllBars(
  db: Db | undefined,
  interval: BarInterval,
  sinceMs: number,
): Promise<Map<string, number>> {
  if (activeBackend() === 'timescale') {
    return countAllBarsPg(interval, sinceMs);
  }
  if (!db) {
    throw new Error('[shared-bars] countAllBars: db parameter required when BARS_BACKEND=mongo (the default)');
  }
  const rows = await db.collection(COLLECTIONS.OHLCV_BARS).aggregate([
    { $match: { interval, is_superseded: false, observation_ts: { $gte: sinceMs } } },
    { $group: { _id: { symbol: '$symbol', market: '$market' }, count: { $sum: 1 } } },
  ]).toArray();
  const out = new Map<string, number>();
  for (const row of rows as Array<{ _id: { symbol: string; market: string }; count: number }>) {
    out.set(`${row._id.symbol}|${row._id.market}`, row.count ?? 0);
  }
  return out;
}

/**
 * Latest unsuperseded `observation_ts` per (symbol, market) for a SET of identities, dispatched per
 * `BARS_BACKEND`, bounded below by `sinceMs`. Returns a Map keyed `${symbol}|${market}`. Backs the
 * self-heal gap detector. `sinceMs` is the OOM-safe floor on Timescale (heal works the 5m series, so
 * the 60d provider cap is the natural bound). Legacy Mongo rows that stored `observation_ts` as a Date
 * are normalised to UTC ms so the Map value type matches both backends.
 *
 * @param db  MongoDB handle. Required when `BARS_BACKEND=mongo` (the default); may be `undefined`
 *           when `BARS_BACKEND=timescale`.
 */
export async function latestObservationForTickers(
  db: Db | undefined,
  ids: ReadonlyArray<TickerIdentity>,
  interval: BarInterval,
  sinceMs: number,
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  if (activeBackend() === 'timescale') {
    return latestObservationForTickersPg(ids, interval, sinceMs);
  }
  if (!db) {
    throw new Error('[shared-bars] latestObservationForTickers: db parameter required when BARS_BACKEND=mongo (the default)');
  }
  const rows = await db.collection(COLLECTIONS.OHLCV_BARS).aggregate([
    { $match: { $or: ids.map((id) => ({ symbol: id.symbol, market: id.market })), interval, is_superseded: false, observation_ts: { $gte: sinceMs } } },
    { $group: { _id: { symbol: '$symbol', market: '$market' }, latest: { $max: '$observation_ts' } } },
  ]).toArray() as Array<{ _id: { symbol: string; market: string }; latest: number | Date }>;
  const out = new Map<string, number>();
  for (const row of rows) {
    const latest = row.latest instanceof Date ? row.latest.getTime() : Number(row.latest);
    if (Number.isFinite(latest)) out.set(`${row._id.symbol}|${row._id.market}`, latest);
  }
  return out;
}

/**
 * Per-(symbol, market) genuine-revision count for `interval` (first-prints excluded) at/after `sinceMs`,
 * dispatched per `BARS_BACKEND`, from the revision audit ledger. Returns a Map keyed `${symbol}|${market}`.
 * Backs the `/coverage` revisions column. The audit ledger lives in the SAME store as the bars writer
 * writes it to (Mongo `bar_revisions_log` on the mongo path; the Timescale `bar_revisions_log` hypertable
 * on the timescale path), so this dispatch keeps `/coverage` honest post-flip.
 *
 * `sinceMs` is the OOM-safe lower bound on Timescale: `bar_revisions_log` is an `observation_ts`-
 * partitioned hypertable, so the PG path window-walks `[sinceMs, now]` (an un-windowed aggregate locks
 * every chunk → "out of shared memory"). Pass the interval's natural floor — the `/coverage` 5m path
 * passes ~75d (a single window). The Mongo branch applies the same `observation_ts >= sinceMs` filter so
 * both backends count the identical set (parity).
 *
 * @param db  MongoDB handle. Required when `BARS_BACKEND=mongo` (the default); may be `undefined`
 *           when `BARS_BACKEND=timescale`.
 */
export async function countRevisionsForTickers(
  db: Db | undefined,
  interval: BarInterval,
  sinceMs: number,
): Promise<Map<string, number>> {
  if (activeBackend() === 'timescale') {
    return countRevisionsForTickersPg(interval, sinceMs);
  }
  if (!db) {
    throw new Error('[shared-bars] countRevisionsForTickers: db parameter required when BARS_BACKEND=mongo (the default)');
  }
  const rows = await db.collection(COLLECTIONS.BAR_REVISIONS_LOG).aggregate([
    { $match: { interval, prior_hash: { $ne: null }, observation_ts: { $gte: sinceMs } } },
    { $group: { _id: { symbol: '$symbol', market: '$market' }, revisions: { $sum: 1 } } },
  ]).toArray();
  const out = new Map<string, number>();
  for (const row of rows as Array<{ _id: { symbol: string; market: string }; revisions: number }>) {
    out.set(`${row._id.symbol}|${row._id.market}`, row.revisions ?? 0);
  }
  return out;
}

/**
 * The revision audit trail for ONE ticker since a knowledge instant, newest-first, dispatched per
 * `BARS_BACKEND`, from the revision audit ledger (the same store the writer writes it to). Bounded by
 * `knowledge_ts >= since` + `limit`. Returns identity-keyed `BarRevisionLogRow`s (the caller re-derives
 * the T212 ticker for display). Backs the operator `/revisions/:ticker` surface.
 *
 * @param db  MongoDB handle. Required when `BARS_BACKEND=mongo` (the default); may be `undefined`
 *           when `BARS_BACKEND=timescale`.
 */
export async function getRevisionsForTicker(
  db: Db | undefined,
  symbol: string,
  market: string,
  since: number,
  limit: number,
): Promise<BarRevisionLogRow[]> {
  if (activeBackend() === 'timescale') {
    return getRevisionsForTickerPg(symbol, market, since, limit);
  }
  if (!db) {
    throw new Error('[shared-bars] getRevisionsForTicker: db parameter required when BARS_BACKEND=mongo (the default)');
  }
  const rows = await db.collection(COLLECTIONS.BAR_REVISIONS_LOG)
    .find({ symbol, market, knowledge_ts: { $gte: since } })
    .sort({ knowledge_ts: -1 })
    .limit(limit)
    .toArray();
  return rows.map((r) => {
    const doc = r as Record<string, unknown>;
    return {
      symbol: String(doc.symbol ?? ''),
      market: String(doc.market ?? ''),
      observation_ts: Number(doc.observation_ts ?? 0),
      interval: String(doc.interval ?? ''),
      knowledge_ts: Number(doc.knowledge_ts ?? 0),
      prior_hash: typeof doc.prior_hash === 'string' ? doc.prior_hash : null,
      new_hash: String(doc.new_hash ?? ''),
    };
  });
}

/**
 * The single latest bar at/<= a knowledge instant (or the latest bar live), dispatching to the
 * active backend per `BARS_BACKEND`. Returns `null` when none qualifies.
 *
 * This is the OOM-safe read the PIT market-cap / dividend-yield enrichment uses INSTEAD of
 * `getBars(..., 'max', { asOf })`: it carries a bounded window anchored at `asOf` (NOT at `now`),
 * so a deep historical as-of and 'now' both touch one row from a bounded slice of chunks via a
 * `DESC … LIMIT 1` read. The old `range='max'` lower-bound scan matched every chunk back to ~1926
 * → Timescale lock-table exhaustion → "out of shared memory" → a 500 to the caller; the asOf-
 * anchored window prunes chunk-exclusion on BOTH bounds so the lock fan never spans the hypertable.
 * The live windowed strategy reads are untouched — this is an additive read used only by enrichment.
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
  const isLive = asOf === undefined;
  const anchor = isLive ? Date.now() : asOf;
  const { symbol, market } = identityOf(ticker);

  // One bounded read in `(anchor - windowMs, anchor]`. Live filters the unsuperseded fast lane;
  // as-of additionally filters `knowledge_ts <= anchor`. `sort(observation_ts DESC, knowledge_ts
  // DESC).limit(1)` already returns the newest observation's latest-knowledge row — no `$group`
  // stage is needed (a single row, not a per-observation pick). Same shape as the PG single-row read.
  const queryWindow = async (windowMs: number): Promise<OHLCVBar | null> => {
    const lowerBound = anchor - windowMs;
    const filter: Record<string, unknown> = {
      symbol,
      market,
      interval,
      observation_ts: { $lte: anchor, $gt: lowerBound },
    };
    if (isLive) filter.is_superseded = false;
    else filter.knowledge_ts = { $lte: anchor };
    const docs = await coll
      .find(filter)
      .sort({ observation_ts: -1, knowledge_ts: -1 })
      .limit(1)
      .toArray();
    return docs[0] ? docToBar(docs[0]) : null;
  };

  // Primary window first; expand once to the bounded wide window on a miss (a long pre-asOf hole).
  let bar = await queryWindow(AT_PRIMARY_WINDOW_MS);
  if (!bar) bar = await queryWindow(AT_WIDE_WINDOW_MS);

  try {
    const payload: CachedBar = { v: 2, cachedAt: Date.now(), bar };
    await redis.setEx(key, CACHE_TTL_SECONDS, JSON.stringify(payload));
  } catch (err) {
    console.warn(`[shared-bars] at-cache write failed for ${key}:`, err);
  }

  return bar;
}

export interface DailyDepth {
  /** Minimum unsuperseded `observation_ts` (UTC ms), or null when the name has no bars. */
  oldest: number | null;
  /** Count of unsuperseded rows (the live series) for (ticker, interval). */
  count: number;
}

/**
 * Persisted daily-series depth for one ticker — `{ oldest, count }` over the UNSUPERSEDED rows —
 * dispatching to the active backend per `BARS_BACKEND`. This is the depth-check the capstone uses to
 * prove how far back the daily series reaches WITHOUT the `range='max'` read that exhausted
 * Timescale's lock table (see getBarAtOrBefore). On Timescale the read walks bounded time windows so
 * no single aggregate plan spans the whole hypertable (an unbounded `min()/count()` would lock every
 * chunk → the same OOM); on Mongo it is a single `$group` (no lock-table failure mode there). Both
 * count only the live (unsuperseded) revision per observation, matching every other live read.
 *
 * @param db  MongoDB handle. Required when `BARS_BACKEND=mongo` (the default); may be `undefined`
 *           when `BARS_BACKEND=timescale`.
 */
export async function getDailyDepth(
  db: Db | undefined,
  ticker: string,
  interval: BarInterval = 'daily',
): Promise<DailyDepth> {
  if (activeBackend() === 'timescale') {
    return getDailyDepthPg(ticker, interval);
  }
  if (!db) {
    throw new Error('[shared-bars] getDailyDepth: db parameter required when BARS_BACKEND=mongo (the default)');
  }
  const coll = db.collection(COLLECTIONS.OHLCV_BARS);
  const { symbol, market } = identityOf(ticker);
  const agg = await coll.aggregate([
    { $match: { symbol, market, interval, is_superseded: false } },
    { $group: { _id: null, oldest: { $min: '$observation_ts' }, count: { $sum: 1 } } },
  ]).toArray();
  const row = agg[0] as { oldest?: unknown; count?: number } | undefined;
  if (!row) return { oldest: null, count: 0 };
  // observation_ts is stored as a number on the Timescale path and as a Date on legacy Mongo writes;
  // normalise either to UTC ms so the returned shape matches the PG reader exactly.
  const oldestRaw = row.oldest;
  const oldest =
    oldestRaw == null ? null
    : oldestRaw instanceof Date ? oldestRaw.getTime()
    : Number(oldestRaw);
  return { oldest: Number.isFinite(oldest as number) ? (oldest as number) : null, count: row.count ?? 0 };
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
  const { symbol, market } = identityOf(ticker);
  const { rows } = await pool.query<{ mid: number; source: string; spread_bps: number | null; observation_ts: string }>(
    `SELECT mid, source, spread_bps, observation_ts FROM quotes
     WHERE symbol = $1 AND market = $2 AND is_superseded = FALSE AND observation_ts <= $3
     ORDER BY observation_ts DESC LIMIT 1`,
    [symbol, market, asOf],
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
  // New Mongo docs carry (symbol, market); re-derive the T212 ticker so OHLCVBar.ticker is
  // byte-identical for downstream consumers. `tickerOf` (adapter.toT212) throws on an unrecognised
  // market, so only call it for a recognised market value — a corrupt/partial doc (market '' or
  // unexpected) falls through to the legacy `ticker` field rather than crashing the whole read.
  const ticker = typeof doc.symbol === 'string' && (doc.market === 'US' || doc.market === 'LSE')
    ? tickerOf(doc.symbol, doc.market)
    : String(doc.ticker ?? '');

  const bar: OHLCVBar = {
    ticker,
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
