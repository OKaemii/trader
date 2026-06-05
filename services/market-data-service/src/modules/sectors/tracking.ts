// Sector-ETF daily-bar tracking. The ETFs are NOT in the tradeable universe, so they're outside
// the universe refresh + EOD feed that keep tradeable tickers fresh — this owns their freshness:
// a one-shot multi-year backfill for any ETF missing history, then a daily 1-year re-backfill
// (idempotent: hash-compared re-polls are dropped) to pick up each new session's bar.

import { getRedisClient } from '@trader/shared-redis';
import { getMongoDb } from '@trader/shared-mongo';
import { backfillDailyHistory, tickersMissingDailyHistory } from '../bars/infrastructure/daily-history.ts';
import { sectorEtfTickers } from './sector-etfs.ts';
import { log } from '../../logger.ts';

/** Backfill (if missing) + start the daily refresh for the sector ETFs. Returns a stop fn. */
export function startSectorEtfTracking(refreshMs: number): () => void {
    const tickers = sectorEtfTickers();

    void (async () => {
        try {
            const db = await getMongoDb();
            const redis = await getRedisClient();
            const missing = await tickersMissingDailyHistory(db, tickers);
            if (missing.length > 0) {
                log.info(`[sectors] backfilling daily history for ${missing.length} sector ETF(s)`);
                await backfillDailyHistory(db, redis, missing, { years: 5 });
            }
        } catch (err) {
            log.warn(`[sectors] initial ETF backfill failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    })();

    const timer = setInterval(() => {
        void (async () => {
            try {
                const db = await getMongoDb();
                const redis = await getRedisClient();
                await backfillDailyHistory(db, redis, tickers, { years: 1 });
            } catch (err) {
                log.warn(`[sectors] ETF daily refresh failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        })();
    }, refreshMs);

    return () => clearInterval(timer);
}
