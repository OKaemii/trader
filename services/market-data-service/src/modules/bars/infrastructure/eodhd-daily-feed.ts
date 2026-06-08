// EODHD bulk end-of-day feed — keeps the persisted daily series fresh for the (large) active
// universe going forward. One bulkLastDay request per exchange returns every symbol's EOD, so a
// full refresh is ~2 EODHD calls/day regardless of universe size. This matters because the
// EODHD-scanned universe (~500 names) is far past TwelveData's free-tier intraday budget, so the
// bulk feed — not the intraday poll — is the daily source under UNIVERSE_SOURCE=eodhd_scan.
//
// Idempotent per (exchange, UTC date) via a Redis NX gate; persists through the bi-temporal
// writeBarRevisions path (re-runs are no-ops). The series can lag one session in the worst case
// (bulk returns the latest *completed* session; the UTC-date gate fetches once/day) — negligible
// for a monthly-rebalanced strategy, and the backfill seeds the historical depth either way.

import type { Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import type { OHLCVBar } from '@trader/shared-types';
import { invalidateBars } from '@trader/shared-bars';
import { writeBarRevisions } from './persist-bars.ts';
import {
  getEodhdClient,
  toEodhdSymbol,
  eodhdCurrencyForExchange,
  eodRowToDailyBar,
  type EodhdBulkRow,
  type EodhdExchange,
} from './providers/eodhd-client.ts';
import { CACHE_INVALIDATED_TOPIC } from './backfill.ts';
import { log } from '../../../logger.ts';

const EXCHANGES: EodhdExchange[] = ['US', 'LSE'];

export interface EodhdFeedResult {
  exchange:  EodhdExchange;
  date:      string;
  matched:   number;
  persisted: number;
  skipped?:  boolean;
}

// The corporate-actions sync pass run after the bulk-EOD pull (plan §8 Gap 1). Decoupled behind this
// shape so the feed doesn't import the store directly and the test can stub it: `syncMany` runs the
// incremental dividend/split sync over the active universe (near-free when current), and a newly-seen
// action fires the store's bound watcher → a forced daily-series re-adjust. Returns aggregate counts
// for logging. Absent ⇒ the feed runs exactly as before (back-compatible).
export interface CorporateActionsSync {
  syncMany(tickers: string[], now?: number): Promise<{ tickers: number; fetched: number; newDividends: number; newSplits: number }>;
}

function utcDate(atMs = Date.now()): string { return new Date(atMs).toISOString().slice(0, 10); }

// {EODHD-code|EXCHANGE -> T212 ticker} for the active universe, so a whole-exchange bulk dump is
// filtered to just the names we hold/read — and we avoid a fetchT212Instruments round-trip.
function activeIndex(activeTickers: string[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const t of activeTickers) {
    const sym = toEodhdSymbol(t);                 // CODE.EX
    const dot = sym.lastIndexOf('.');
    if (dot < 0) continue;
    idx.set(`${sym.slice(0, dot).toUpperCase()}|${sym.slice(dot + 1).toUpperCase()}`, t);
  }
  return idx;
}

/** Pure: map a whole-exchange bulk dump to daily bars for the active-universe names only. */
export function buildEodhdFeedBars(rows: EodhdBulkRow[], exchange: EodhdExchange, activeTickers: string[]): OHLCVBar[] {
  const idx = activeIndex(activeTickers);
  const { currency, priceScale } = eodhdCurrencyForExchange(exchange);
  const bars: OHLCVBar[] = [];
  for (const r of rows) {
    const ticker = idx.get(`${r.code.toUpperCase()}|${exchange}`);
    if (!ticker) continue;                         // not in the active universe
    const bar = eodRowToDailyBar(ticker, r, currency, priceScale);
    if (bar) bars.push(bar);
  }
  return bars;
}

export async function runEodhdDailyFeed(
  db: Db,
  redis: RedisClientType,
  activeTickers: string[],
  // Optional corporate-actions sync — run AFTER the bulk-EOD pull so a new split/dividend triggers a
  // forced daily-series re-adjust on the same EOD cycle (plan §8 Gap 1). Absent ⇒ unchanged behaviour.
  corporateActions?: CorporateActionsSync,
): Promise<EodhdFeedResult[]> {
  if (activeTickers.length === 0) return [];
  const client = getEodhdClient();
  const results: EodhdFeedResult[] = [];

  for (const ex of EXCHANGES) {
    const date = utcDate();
    const gateKey = `market-data:eodhd-feed:${ex}:${date}`;
    const acquired = await redis.set(gateKey, '1', { NX: true, EX: 25 * 60 * 60 });
    if (!acquired) { results.push({ exchange: ex, date, matched: 0, persisted: 0, skipped: true }); continue; }

    const rows = await client.bulkLastDay(ex);
    if (rows.length === 0) {
      log.warn(`[eodhd-feed] ${ex}: bulk returned no rows (budget / API) — releasing gate to retry`);
      await redis.del(gateKey).catch(() => {});    // let a later cycle retry today
      results.push({ exchange: ex, date, matched: 0, persisted: 0 });
      continue;
    }
    const bars = buildEodhdFeedBars(rows, ex, activeTickers);
    const stats = await writeBarRevisions(db, bars, 'daily');
    const persisted = stats.inserted + stats.revisions;
    await Promise.allSettled(bars.map((b) => invalidateBars(redis, b.ticker, 'daily')));
    try {
      await redis.publish(CACHE_INVALIDATED_TOPIC, JSON.stringify({ interval: 'daily', source: 'eodhd-feed', exchange: ex, date, count: bars.length, ts: Date.now() }));
    } catch { /* pubsub best-effort */ }
    log.info(`[eodhd-feed] ${ex} ${date}: ${rows.length} bulk rows, ${bars.length} matched active universe, ${persisted} persisted`);
    results.push({ exchange: ex, date, matched: bars.length, persisted });
  }

  // Corporate-actions pass (plan §8 Gap 1) — run once after the bulk-EOD pull, over the whole active
  // universe. The store's per-ticker TTL gate keeps this near-free when nothing is new; a newly-seen
  // split/dividend fires the bound watcher → a forced re-adjust of that ticker's daily series so the
  // seeded history is re-based off the provider's re-adjusted closes (no stale-adjustment discontinuity).
  // Best-effort: any failure here must never compromise the daily-bar write that already succeeded.
  if (corporateActions) {
    try {
      const ca = await corporateActions.syncMany(activeTickers);
      if (ca.newDividends > 0 || ca.newSplits > 0) {
        log.info(`[eodhd-feed] corporate-actions: +${ca.newDividends} dividends, +${ca.newSplits} splits across ${ca.fetched}/${ca.tickers} tickers — re-adjust triggered`);
      }
    } catch (err) {
      log.warn('[eodhd-feed] corporate-actions sync failed (continuing):', err);
    }
  }

  return results;
}
