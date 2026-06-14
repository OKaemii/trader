// The daily-emit fold: roll one UTC day's persisted 5m bars (per market) up into one
// daily bar per ticker, persist it bi-temporally, invalidate the daily read-cache, and
// publish the set onto market:raw:daily — the stream strategy-engine consumes to cycle.
//
// This is the shared body of two call sites that must fold identically:
//   • maybeEmitDailyAtClose (index.ts) — the gated session-close path (once per
//     (market, UTC-date) via a Redis NX gate).
//   • POST /admin/api/market-data/daily-emit/force (admin routes) — the operator-driven
//     path that BYPASSES the gate so a past/missed day can be re-emitted on demand.
// Factored here so both run the exact same read→group→aggregate→persist→publish — the
// gate is the ONLY difference, and it lives at the caller, not in the fold.
//
// The 5m read goes through the BARS_BACKEND-dispatched SET reader, never a raw Mongo find:
// live config is BARS_BACKEND=timescale, so reads dispatch to Timescale. The original RC1 bug
// was a HARDCODED Mongo 5m read that returned 0 rows once the wipe ran, starving market:raw:daily
// and idling the strategy. The reader honours the backend, splits each T212 partition ticker to
// its bare (symbol, market) identity (storage is keyed bare), filters is_superseded:false + the
// observation_ts >= sinceTs day floor, and returns OHLCVBar[] with the T212 ticker re-derived
// per row.
//
// STORE-INVERSION CAVEAT (RC4 audit, card 218). The WRITE side below (writeBarRevisions) is the
// MIRROR-IMAGE problem and is NOT yet fixed: it is still Mongo-primary (Timescale only when
// DUAL_WRITE_BARS=true — currently false), so this fold's persist writes the daily bar to MONGO
// while a getBars('daily') read dispatches to TIMESCALE; the emitted daily bar is invisible to a
// Timescale daily read-back, and the persisted daily series diverges between the two stores. The
// revival rides the market:raw:daily STREAM publish (below), which is store-agnostic, so the
// strategy still cycles regardless. The durable fix is to flip writeBarRevisions to dispatch on
// BARS_BACKEND (Timescale-primary under `timescale`) so writes land where reads look — its own
// follow-up card.

import type { Db } from 'mongodb';
import type { getRedisClient } from '@trader/shared-redis';
import { xAdd } from '@trader/shared-redis';
import { aggregateBars, invalidateBarsBulk, getRecentBarsForTickers } from '@trader/shared-bars';
import { Trading212TickerAdapter } from '@trader/ticker-identity';
import { REDIS_STREAMS, type OHLCVBar, type BarInterval } from '@trader/shared-types';
import { writeBarRevisions } from './persist-bars.ts';

const tickerAdapter = new Trading212TickerAdapter();

export interface DailyEmitFoldResult {
  /** Number of daily bars published to market:raw:daily (one per ticker that had 5m bars). */
  emitted: number;
}

/**
 * Fold one UTC day's 5m bars for a set of T212 tickers into daily bars and publish them.
 *
 * Reads the latest unsuperseded 5m bars at/after `sinceTs` (the UTC-day floor) through the
 * dispatched set reader, optionally trims them to a single UTC day with `upperBoundTs`
 * (exclusive — for re-emitting a PAST date so it folds only that day; omit for "today",
 * whose upper bound is in the future anyway), groups by ticker, aggregates each ticker's
 * series to one daily bar, persists the set bi-temporally, drops the daily read-cache, and
 * xAdds the set onto market:raw:daily.
 *
 * Returns `{ emitted }` (0 when no 5m bars exist for the window, or the aggregation yields
 * nothing). NEVER throws on an empty day — an empty result is a valid no-op the callers
 * report as `emitted: 0`. The reader is lower-bounded by `sinceTs` so the Timescale read
 * stays chunk-exclusion-pruned (OOM-safe); `upperBoundTs` only trims the already-bounded
 * result set in memory.
 */
export async function foldDailyEmit(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  db: Db,
  tickers: readonly string[],
  sinceTs: number,
  upperBoundTs?: number,
): Promise<DailyEmitFoldResult> {
  if (tickers.length === 0) return { emitted: 0 };

  const ids = tickers.map((t) => tickerAdapter.fromT212(t));
  let bars = await getRecentBarsForTickers(redis, db, ids, { interval: '5m', sinceTs });
  // Cap the upper bound to the requested UTC day. For "today" upperBoundTs is the next
  // UTC midnight (a future instant) so this filters nothing; for a past date it keeps the
  // fold to that single day rather than every 5m bar persisted since (the reader has no
  // upper bound of its own).
  if (upperBoundTs !== undefined) {
    bars = bars.filter((b) => b.observation_ts < upperBoundTs);
  }
  if (bars.length === 0) return { emitted: 0 };

  // Group by ticker, then aggregate-to-daily one ticker at a time so aggregateBars sees a
  // single ticker's bars (it folds all rows into one output bar keyed by the head ticker).
  // The reader already returns fully-formed OHLCVBar[] (T212 ticker re-derived, OHLCV
  // populated) for both backends, so we group on bar.ticker directly — no doc→bar conversion.
  const byTicker = new Map<string, OHLCVBar[]>();
  for (const bar of bars) {
    let list = byTicker.get(bar.ticker);
    if (!list) { list = []; byTicker.set(bar.ticker, list); }
    list.push(bar);
  }
  const dailyBars: OHLCVBar[] = [];
  for (const list of byTicker.values()) {
    const agg = aggregateBars(list, 'daily');
    const last = agg[agg.length - 1];
    if (last) dailyBars.push(last);
  }
  if (dailyBars.length === 0) return { emitted: 0 };

  await writeBarRevisions(db, dailyBars, 'daily');
  // Drop the daily read-cache so the next getBars('daily', …) reflects this close.
  await invalidateBarsBulk(
    redis as never,
    dailyBars.map((b) => ({ ticker: b.ticker, interval: 'daily' as BarInterval })),
  );
  await xAdd(redis, REDIS_STREAMS.MARKET_RAW_DAILY, dailyBars);
  return { emitted: dailyBars.length };
}
