// daily-history — seed + maintain the persisted `interval:'daily'` series that backs
// long-horizon strategy lookbacks (e.g. 12-1 momentum needs ~273 trading days, far past
// the 60-day 5m provider cap). Sourced from EODHD `/eod` (paid bulk-EOD, multi-year),
// decoupled from the metered TwelveData 5m feed. The EOD daily emit (maybeEmitDailyAtClose)
// keeps the series fresh going forward; this module seeds the historical depth.
//
// Bi-temporal: writes go through writeBarRevisions exactly like the 5m path — idempotent
// re-backfill is a no-op, genuine revisions append + supersede.

import type { Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import { invalidateBars, countBarsForTickers } from '@trader/shared-bars';
import { Trading212TickerAdapter } from '@trader/ticker-identity';
import type { OHLCVBar } from '@trader/shared-types';
import { writeBarRevisions } from './persist-bars.ts';
import { fetchEodhdDailyHistory } from './providers/eodhd-client.ts';
import { CACHE_INVALIDATED_TOPIC, planGapWindows } from './backfill.ts';
import { log } from '../../../logger.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
// OOM-safe lower bound for the dispatched daily count. The persisted daily series can reach 1990→now;
// an UNBOUNDED count over that deep hypertable locks every chunk → "out of shared memory". The
// write-gating question is only "does this name have ≥`minBars` (≈280) recent daily bars?", so a 3-year
// window (~750 trading days) gives ample headroom over the 280 threshold while pruning the Timescale
// aggregate to a bounded chunk slice. A currently-listed name (the whole active universe) always has
// far more than 280 bars in 3y; a name with no recent daily data simply re-runs the (idempotent,
// gap-aware) backfill. On Mongo the bound only excludes rows older than 3y (none affect the threshold).
const DAILY_COVERAGE_WINDOW_MS = 3 * 365 * DAY_MS;
// Bridge interior daily holes up to 4 days — a weekend (2d) plus an adjacent long-weekend
// holiday — so weekends/holidays in a fully-seeded series don't trigger no-yield re-fetches.
// A genuinely-missing run of trading days exceeds this and stays a fetchable interior gap.
const DAILY_BRIDGE_MS = 4 * DAY_MS;

export interface DailyBackfillResult {
  ticker:   string;
  fetched:  number;
  upserted: number;
  error?:   string;
}

export interface DailyBackfillOpts {
  years?:       number;   // default: DAILY_BACKFILL_YEARS env or 5
  concurrency?: number;   // default 4 (Yahoo is gentle but unmetered; keep it polite)
  // Gap-aware escape hatch. Default (false): fetch ONLY the daily observation dates we don't
  // already hold — a fully-seeded ticker spends zero upstream calls / zero EODHD credits.
  // `forceRefetch: true` re-downloads the whole multi-year span (the pre-gap-aware behaviour)
  // to repair a suspected-bad span; never the default. See research-trading-os.md §I.
  forceRefetch?: boolean;
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
  const force       = opts.forceRefetch ?? false;
  const endMs       = Date.now();
  const startMs     = endMs - Math.max(1, years) * 365 * DAY_MS;

  const results: DailyBackfillResult[] = [];
  for (let i = 0; i < tickers.length; i += concurrency) {
    const slice = tickers.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      slice.map((t) => backfillDailyOne(db, redis, t, startMs, endMs, force)),
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

// Long-range daily source. EODHD `/eod` is the only daily-history upstream now (the Yahoo path was
// removed with the rest of the Yahoo clients — epic pit-fundamentals-lake-rearchitecture, Thread C).
// Returns oldest-first daily OHLCVBar[] tagged interval:'daily'; writeBarRevisions persists them
// bi-temporally + idempotently.
function fetchDailyHistory(ticker: string, startMs: number, endMs: number): Promise<OHLCVBar[]> {
  return fetchEodhdDailyHistory(ticker, startMs, endMs);
}

async function backfillDailyOne(
  db: Db,
  redis: RedisClientType,
  ticker: string,
  startMs: number,
  endMs: number,
  force: boolean,
): Promise<DailyBackfillResult> {
  // Gap-aware FETCH planning. Unless `force`, fetch only the daily observation dates we don't
  // already hold — a fully-seeded ticker spends zero upstream calls / zero EODHD credits. The
  // provider paginates each gap window internally. `force` re-fetches the whole span (one call)
  // to repair a suspected-bad span. The write path stays unchanged either way: every fetched
  // bar still flows through the hash-gated, bi-temporal writeBarRevisions.
  let fetchWindows: Array<{ startMs: number; endMs: number }>;
  if (force) {
    fetchWindows = [{ startMs, endMs }];
  } else {
    const gaps = await planGapWindows(db, ticker, 'daily', startMs, endMs, DAY_MS, DAILY_BRIDGE_MS);
    if (gaps.length === 0) {
      // Fully covered: zero upstream calls, zero credits. No new bars ⇒ nothing to invalidate.
      return { ticker, fetched: 0, upserted: 0 };
    }
    // MissingRange.end is the last missing day (00:00:00Z); +DAY_MS makes the provider's upper
    // bound inclusive of that day.
    fetchWindows = gaps.map((g) => ({ startMs: g.start, endMs: g.end + DAY_MS }));
  }

  const bars = (
    await Promise.all(fetchWindows.map((w) => fetchDailyHistory(ticker, w.startMs, w.endMs)))
  ).flat();
  if (bars.length === 0) {
    log.warn(`[daily-history] ${ticker}: eodhd returned no daily history`);
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
 *
 * STORE: counts through the `BARS_BACKEND`-dispatched `countBarsForTickers`, so it gates the deep
 * daily backfill off the store the daily series is WRITTEN to (the same dispatch as the writer). (The
 * OOM-safe Timescale daily DEPTH read — `getDailyDepth` / `GET /admin/api/market-data/daily-depth` —
 * is the separate read-side surface that PROVES depth post-backfill; this is the write-gating count.)
 * Bounded by the 3-year coverage window so the Timescale count stays chunk-pruned (lock safety) — see
 * `DAILY_COVERAGE_WINDOW_MS`.
 */
export async function tickersMissingDailyHistory(
  db: Db,
  tickers: string[],
  minBars = 280,
): Promise<string[]> {
  if (tickers.length === 0) return [];
  // Storage is keyed on (symbol, market); split the T212 tickers, count per identity, and re-key the
  // result back to T212 form for the returned "missing" list.
  const adapter = new Trading212TickerAdapter();
  const ids = tickers.map((t) => ({ ticker: t, ...adapter.fromT212(t) }));
  const tickerByIdentity = new Map(ids.map((i) => [`${i.symbol}|${i.market}`, i.ticker]));
  const sinceMs = Date.now() - DAILY_COVERAGE_WINDOW_MS;
  const counts = await countBarsForTickers(db, ids.map((i) => ({ symbol: i.symbol, market: i.market })), 'daily', sinceMs);
  const sufficient = new Set(
    [...counts.entries()]
      .filter(([, count]) => count >= minBars)
      .map(([key]) => tickerByIdentity.get(key))
      .filter((t): t is string => t !== undefined),
  );
  return tickers.filter((t) => !sufficient.has(t));
}
