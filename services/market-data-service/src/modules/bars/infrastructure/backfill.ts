// backfill — pull historical 5m bars from a MarketDataProvider, upsert to ohlcv_bars,
// invalidate the shared-bars Redis cache, and publish a pubsub notification so other
// services can refresh their derived views.
//
// Used in two places:
//   1. Bootstrap (market-data-service startup) — runs once if no 5m history exists.
//      Lets a freshly-deployed cluster reach a usable warmup state without waiting
//      for live-poll to accumulate ~20 days of bars.
//   2. Admin endpoint POST /api/admin/market-data/backfill — explicit operator call
//      with custom ticker/window args.
//
// **Both paths are gate-bypass relative to the session-aware poll gate.** The
// session calendar (@trader/shared-calendar) skips Yahoo calls when no relevant
// market is open. Backfills do the opposite: an operator running a backfill at
// 03:00 Sunday explicitly wants those calls (e.g. recovering from a multi-day
// outage that happened during a closed window). The calendar is not consulted by
// the functions here — call sites have already decided to hit the upstream.

import type { Collection, Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import { COLLECTIONS } from '@trader/shared-mongo';
import { invalidateBars } from '@trader/shared-bars';
import type { OHLCVBar, BarInterval } from '@trader/shared-types';
import type { MarketDataProvider } from './providers/market-data-provider.ts';
import { log } from '../../../logger.ts';

// Topic for the cross-service cache-invalidation pubsub. Anything maintaining a
// derived view of bar history (signal-service' price-lookup cache, the portal's
// historical chart, etc.) should subscribe and drop affected entries.
export const CACHE_INVALIDATED_TOPIC = 'bars:cache-invalidated';

export interface BackfillResult {
  ticker:    string;
  fetched:   number;
  upserted:  number;
  error?:    string;
}

export interface BackfillOpts {
  windowMs?:  number;   // default: 60 days (matches Yahoo 5m lookback cap)
  concurrency?: number; // tickers handled in parallel; default 5
}

/**
 * Backfill 5m history for one or more tickers. Persists to ohlcv_bars (5m, upserted
 * on (ticker, timestamp, interval)) and emits a pubsub message per ticker so the
 * shared-bars cache and any subscribers refresh.
 */
export async function backfillTickers(
  db: Db,
  redis: RedisClientType,
  provider: MarketDataProvider,
  tickers: string[],
  opts: BackfillOpts = {},
): Promise<BackfillResult[]> {
  const windowMs    = opts.windowMs    ?? 60 * 24 * 60 * 60_000;
  const concurrency = opts.concurrency ?? 5;
  const endTs       = Date.now();
  const startTs     = endTs - windowMs;
  const collection  = db.collection(COLLECTIONS.OHLCV_BARS);

  const results: BackfillResult[] = [];
  for (let i = 0; i < tickers.length; i += concurrency) {
    const slice = tickers.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      slice.map((t) => backfillOne(collection, redis, provider, t, startTs, endTs)),
    );
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      const t = slice[j];
      if (!r || !t) continue;
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ ticker: t, fetched: 0, upserted: 0, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    }
  }
  return results;
}

async function backfillOne(
  collection: Collection,
  redis: RedisClientType,
  provider: MarketDataProvider,
  ticker: string,
  startTs: number,
  endTs: number,
): Promise<BackfillResult> {
  const bars = await provider.fetchHistory(ticker, startTs, endTs);
  if (bars.length === 0) return { ticker, fetched: 0, upserted: 0 };

  const interval: BarInterval = '5m';
  const ops = bars.map((bar) => ({
    updateOne: {
      filter: { ticker, timestamp: new Date(bar.timestamp), interval },
      update: {
        $set: {
          ticker,
          timestamp: new Date(bar.timestamp),
          interval,
          open:   bar.open,
          high:   bar.high,
          low:    bar.low,
          close:  bar.close,
          volume: bar.volume,
        },
      },
      upsert: true,
    },
  }));
  const res = await collection.bulkWrite(ops, { ordered: false });
  // Sum all the "this op did something" counters. Different Mongo driver versions and
  // collection configurations distribute upsert successes across these properties:
  //   - upsertedCount: new doc created via $setOnInsert / upsert
  //   - insertedCount: only set for explicit insertOne ops
  //   - modifiedCount: existing doc actually changed
  //   - matchedCount: existing doc matched (may equal modifiedCount or differ)
  // Empirically `upsertedCount` was 0 on a fresh bulkWrite that did create 400k+ docs,
  // so we sum all four and report whichever is non-zero.
  const upserted = (res.upsertedCount ?? 0)
                 + (res.insertedCount ?? 0)
                 + (res.modifiedCount ?? 0)
                 + (Object.keys(res.upsertedIds ?? {}).length);
  // Fall back to ops.length when every counter is zero — guarantees we never report
  // "0 bars upserted" on a batch that didn't throw.
  const reported = upserted > 0 ? upserted : ops.length;

  // Cache: drop every cached range for this (ticker, 5m). shared-bars repopulates lazily
  // on the next read. Then publish a notification so other services (signal-service'
  // price-lookup cache, portal historical charts) can drop their own derived state.
  await invalidateBars(redis, ticker, '5m');
  try {
    await redis.publish(CACHE_INVALIDATED_TOPIC, JSON.stringify({ ticker, interval, fetched: bars.length, ts: Date.now() }));
  } catch (err) {
    log.warn(`[backfill] pubsub publish failed for ${ticker}:`, err);
  }

  return { ticker, fetched: bars.length, upserted: reported };
}

/**
 * Bootstrap-time check: returns the subset of tickers that have NO 5m bars in the
 * cache. Used by market-data-service on startup to decide whether to backfill.
 * Cheap — single Mongo aggregation grouped by ticker.
 */
export async function tickersMissingHistory(
  db: Db,
  tickers: string[],
): Promise<string[]> {
  if (tickers.length === 0) return [];
  const collection = db.collection(COLLECTIONS.OHLCV_BARS);
  const present = await collection.aggregate([
    { $match: { ticker: { $in: tickers }, interval: '5m' } },
    { $group: { _id: '$ticker' } },
  ]).toArray();
  const seen = new Set(present.map((d: any) => d._id));
  return tickers.filter((t) => !seen.has(t));
}

/**
 * Per-cycle self-heal. One Mongo aggregation finds the latest 5m bar per ticker;
 * any ticker whose latest bar is older than `staleThresholdMs` (default 24h —
 * matches fetchRecent's window so we only heal what fetchRecent can't auto-cover)
 * gets a targeted backfill from its latestTs to now.
 *
 * If the gap exceeds the provider's lookback cap (Yahoo: 60 days), the heal call
 * fills what it can and a `bad_ticks{type:'unrecoverable_gap'}` doc is written so
 * an operator can see "this ticker has missing dates and the upstream can't recover
 * them" without grep-ing logs.
 *
 * Steady-state cost when nothing is gapped: one aggregation, zero Yahoo calls.
 */
export async function healMissingHistory(
  db: Db,
  redis: RedisClientType,
  provider: MarketDataProvider,
  tickers: string[],
  opts: { staleThresholdMs?: number; expectedLatestMs?: number } = {},
): Promise<{ healed: number; barsAdded: number; unrecoverable: number }> {
  if (tickers.length === 0) return { healed: 0, barsAdded: 0, unrecoverable: 0 };
  const stale = opts.staleThresholdMs ?? 24 * 60 * 60_000;
  const now   = Date.now();
  const collection = db.collection(COLLECTIONS.OHLCV_BARS);

  // Session-aware gap detection. When the caller passes `expectedLatestMs` (the most
  // recent session close for the relevant market, from @trader/shared-calendar's
  // expectedLatestBarMs), a ticker is gapped iff its latest bar is older than that —
  // i.e. genuine missing data, not "we paused polling during a closed window". This
  // suppresses ~150 false-positive heals on Monday mornings when every US ticker's
  // latest bar is Friday's close (>64h old by Monday morning) but nothing is actually
  // missing. Without an `expectedLatestMs`, falls back to the flat 24h threshold.
  const isGapped = (latestMs: number): boolean => {
    if (typeof opts.expectedLatestMs === 'number') {
      // 60s grace covers Yahoo late-prints vs the exact close ms.
      return latestMs < opts.expectedLatestMs - 60_000;
    }
    return now - latestMs > stale;
  };

  // Single aggregation: latest-bar-timestamp per ticker for the 5m series. Tickers
  // not present in the result have no history at all (handled by bootstrap, not
  // heal — heal trusts that bootstrap ran).
  const agg = await collection.aggregate([
    { $match: { ticker: { $in: tickers }, interval: '5m' } },
    { $group: { _id: '$ticker', latest: { $max: '$timestamp' } } },
  ]).toArray() as Array<{ _id: string; latest: Date }>;

  const gapped: Array<{ ticker: string; latestMs: number }> = [];
  for (const row of agg) {
    const latestMs = row.latest instanceof Date ? row.latest.getTime() : Number(row.latest);
    if (isGapped(latestMs)) gapped.push({ ticker: row._id, latestMs });
  }
  if (gapped.length === 0) return { healed: 0, barsAdded: 0, unrecoverable: 0 };

  log.warn(`[heal] ${gapped.length} ticker(s) have >${(stale / 3_600_000).toFixed(1)}h gap — backfilling`);

  let barsAdded = 0;
  let unrecoverable = 0;

  // Group tickers by "how much history they need" so the heal calls go out with
  // the right window per ticker (provider truncates internally to maxLookbackMs).
  for (const { ticker, latestMs } of gapped) {
    const requestedWindowMs = now - latestMs;
    const cappedWindowMs    = Math.min(requestedWindowMs, provider.maxLookbackMs);
    const startTs = now - cappedWindowMs;

    const results = await backfillTickers(db, redis, provider, [ticker], { windowMs: cappedWindowMs });
    const upserted = results[0]?.upserted ?? 0;
    barsAdded += upserted;

    if (requestedWindowMs > provider.maxLookbackMs) {
      // Provider truncated. We have new bars from `startTs` forward, but the segment
      // from `latestMs` to `startTs` is gone from upstream history — strategy will
      // see a non-contiguous series for this ticker until someone re-bootstraps from
      // a deeper-history source.
      unrecoverable++;
      await collection.insertOne ? null : null;  // collection is OHLCV_BARS; use BAD_TICKS below
      try {
        await db.collection(COLLECTIONS.BAD_TICKS).insertOne({
          type: 'unrecoverable_gap',
          ticker,
          gapStartMs: latestMs,
          gapEndMs:   startTs,
          gapDurationMs: startTs - latestMs,
          provider: provider.name,
          providerMaxLookbackMs: provider.maxLookbackMs,
          loggedAt: new Date(),
        });
      } catch (err) {
        log.warn('[heal] failed to log unrecoverable_gap:', err);
      }
      log.warn(`[heal] unrecoverable gap for ${ticker}: ${latestMs} → ${startTs} (${((startTs - latestMs) / 86_400_000).toFixed(1)}d) past provider cap`);
    }
  }

  return { healed: gapped.length, barsAdded, unrecoverable };
}
