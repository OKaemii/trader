// daily-history — seed + maintain the persisted `interval:'daily'` series that backs
// long-horizon strategy lookbacks (e.g. 12-1 momentum needs ~273 trading days, far past
// the 60-day 5m provider cap). Sourced from Yahoo daily (free, multi-year), decoupled from
// the metered TwelveData 5m feed — the same "stays on Yahoo regardless" split as the FX and
// sector clients. The EOD daily emit (maybeEmitDailyAtClose) keeps the series fresh going
// forward; this module seeds the historical depth.
//
// Bi-temporal: writes go through writeBarRevisions exactly like the 5m path — idempotent
// re-backfill is a no-op, genuine revisions append + supersede.

import type { Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import { COLLECTIONS } from '@trader/shared-mongo';
import { invalidateBars } from '@trader/shared-bars';
import type { OHLCVBar } from '@trader/shared-types';
import { writeBarRevisions } from './persist-bars.ts';
import { fetchYahooDailyHistory } from './providers/yahoo-client.ts';
import { fetchEodhdDailyHistory } from './providers/eodhd-client.ts';
import { CACHE_INVALIDATED_TOPIC } from './backfill.ts';
import { log } from '../../../logger.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DailyBackfillResult {
  ticker:   string;
  fetched:  number;
  upserted: number;
  error?:   string;
}

export interface DailyBackfillOpts {
  years?:       number;   // default: DAILY_BACKFILL_YEARS env or 5
  concurrency?: number;   // default 4 (Yahoo is gentle but unmetered; keep it polite)
}

/**
 * Backfill multi-year daily history for one or more tickers from Yahoo. Persists to
 * ohlcv_bars as `interval:'daily'` and invalidates the shared-bars daily cache so the
 * next read repopulates. Idempotent: re-running writes zero rows for unchanged days.
 */
export async function backfillDailyHistory(
  db: Db,
  redis: RedisClientType,
  tickers: string[],
  opts: DailyBackfillOpts = {},
): Promise<DailyBackfillResult[]> {
  const years       = opts.years ?? Number(process.env.DAILY_BACKFILL_YEARS ?? 5);
  const concurrency = opts.concurrency ?? 4;
  const endMs       = Date.now();
  const startMs     = endMs - Math.max(1, years) * 365 * DAY_MS;

  const results: DailyBackfillResult[] = [];
  for (let i = 0; i < tickers.length; i += concurrency) {
    const slice = tickers.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      slice.map((t) => backfillDailyOne(db, redis, t, startMs, endMs)),
    );
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      const t = slice[j];
      if (!r || !t) continue;
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ ticker: t, fetched: 0, upserted: 0, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    }
  }
  const totalUpserted = results.reduce((a, r) => a + r.upserted, 0);
  log.info(`[daily-history] backfilled ${tickers.length} ticker(s), ${totalUpserted} daily rows written`);
  return results;
}

// Long-range daily source dispatch. DAILY_HISTORY_PROVIDER selects 'yahoo' (free, default) or
// 'eodhd' (paid bulk-EOD). Both return oldest-first daily OHLCVBar[] tagged interval:'daily';
// writeBarRevisions persists them identically (bi-temporal, idempotent).
function fetchDailyHistory(ticker: string, startMs: number, endMs: number): Promise<OHLCVBar[]> {
  const src = (process.env.DAILY_HISTORY_PROVIDER ?? 'yahoo').toLowerCase();
  return src === 'eodhd'
    ? fetchEodhdDailyHistory(ticker, startMs, endMs)
    : fetchYahooDailyHistory(ticker, startMs, endMs);
}

async function backfillDailyOne(
  db: Db,
  redis: RedisClientType,
  ticker: string,
  startMs: number,
  endMs: number,
): Promise<DailyBackfillResult> {
  const bars = await fetchDailyHistory(ticker, startMs, endMs);
  if (bars.length === 0) {
    const src = (process.env.DAILY_HISTORY_PROVIDER ?? 'yahoo').toLowerCase();
    log.warn(`[daily-history] ${ticker}: ${src} returned no daily history`);
    return { ticker, fetched: 0, upserted: 0 };
  }
  const stats = await writeBarRevisions(db, bars, 'daily');
  const reported = stats.inserted > 0 ? stats.inserted : (stats.skipped > 0 ? 0 : bars.length);

  await invalidateBars(redis, ticker, 'daily');
  try {
    await redis.publish(CACHE_INVALIDATED_TOPIC, JSON.stringify({ ticker, interval: 'daily', fetched: bars.length, ts: Date.now() }));
  } catch (err) {
    log.warn(`[daily-history] pubsub publish failed for ${ticker}:`, err);
  }
  return { ticker, fetched: bars.length, upserted: reported };
}

/**
 * Bootstrap check: the subset of tickers with INSUFFICIENT persisted daily history for a
 * long lookback. `minBars` defaults to 280 (≈ 12-1 momentum's 252 lookback + 21 skip + a
 * small buffer). Counts only the latest unsuperseded revision per (ticker, observation_ts).
 */
export async function tickersMissingDailyHistory(
  db: Db,
  tickers: string[],
  minBars = 280,
): Promise<string[]> {
  if (tickers.length === 0) return [];
  const coll = db.collection(COLLECTIONS.OHLCV_BARS);
  const counts = await coll.aggregate([
    { $match: { ticker: { $in: tickers }, interval: 'daily', is_superseded: false } },
    { $group: { _id: '$ticker', count: { $sum: 1 } } },
  ]).toArray();
  const sufficient = new Set(
    counts.filter((d: Record<string, unknown>) => (d.count as number) >= minBars).map((d: Record<string, unknown>) => d._id as string),
  );
  return tickers.filter((t) => !sufficient.has(t));
}
