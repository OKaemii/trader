// Swing screener orchestrator: scan the active universe's daily series, score each via screenTicker,
// persist an append-only top-N snapshot. Thresholds come from a PORTAL_RUNTIME_CONFIG doc
// (`_id:'swing_screener'`) with a 15s cache + bounds, mirroring the portal_* override convention.

import { getBars } from '@trader/shared-bars';
import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import { getRedisClient } from '@trader/shared-redis';
import { screenTicker, DEFAULT_THRESHOLDS, type ScreenerThresholds, type SwingScreenRow } from './screen.ts';
import { log } from '../../logger.ts';

export interface ScreenSnapshot {
    runAt: number;
    criteria: ScreenerThresholds;
    rows: SwingScreenRow[];
    scanned: number;
}

const THRESH_CACHE_MS = 15_000;
let threshCache: { value: ScreenerThresholds; ts: number } | null = null;
const clamp = (v: unknown, lo: number, hi: number, dflt: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;

export async function getScreenerThresholds(): Promise<ScreenerThresholds> {
    if (threshCache && Date.now() - threshCache.ts < THRESH_CACHE_MS) return threshCache.value;
    let doc: Record<string, unknown> | null = null;
    try {
        const db = await getMongoDb();
        const d = await db.collection(COLLECTIONS.PORTAL_RUNTIME_CONFIG).findOne({ _id: 'swing_screener' as never });
        doc = (d?.['thresholds'] as Record<string, unknown>) ?? null;
    } catch (err) {
        log.warn(`[screener] threshold read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const value: ScreenerThresholds = {
        near52wHighPct:  clamp(doc?.['near52wHighPct'],  0.001, 0.5, DEFAULT_THRESHOLDS.near52wHighPct),
        volSurgeMult:    clamp(doc?.['volSurgeMult'],    1,     20,  DEFAULT_THRESHOLDS.volSurgeMult),
        pullbackBandPct: clamp(doc?.['pullbackBandPct'], 0.001, 0.5, DEFAULT_THRESHOLDS.pullbackBandPct),
        topN:            Math.trunc(clamp(doc?.['topN'], 1,     50,  DEFAULT_THRESHOLDS.topN)),
    };
    threshCache = { value, ts: Date.now() };
    return value;
}

export function invalidateScreenerThresholds(): void { threshCache = null; }

export class SwingScreener {
    constructor(private readonly activeTickers: () => string[]) {}

    async run(): Promise<{ runAt: number; scanned: number; count: number }> {
        const db = await getMongoDb();
        const redis = await getRedisClient();
        const t = await getScreenerThresholds();
        const tickers = this.activeTickers();
        const rows: SwingScreenRow[] = [];
        for (const ticker of tickers) {
            try {
                const bars = await getBars(redis as never, db, ticker, 'daily', '1y');
                const row = screenTicker(ticker, bars, t);
                if (row) rows.push(row);
            } catch (err) {
                log.warn(`[screener] ${ticker}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        rows.sort((a, b) => b.score - a.score);
        const top = rows.slice(0, t.topN);
        const snap: ScreenSnapshot = { runAt: Date.now(), criteria: t, rows: top, scanned: tickers.length };
        await db.collection(COLLECTIONS.SWING_SCREEN_RESULTS).insertOne(snap as never);
        log.info(`[screener] scanned ${tickers.length}, ${rows.length} candidates, kept top ${top.length}`);
        return { runAt: snap.runAt, scanned: tickers.length, count: top.length };
    }

    async latest(): Promise<ScreenSnapshot | null> {
        const db = await getMongoDb();
        return db.collection<ScreenSnapshot>(COLLECTIONS.SWING_SCREEN_RESULTS)
            .find().sort({ runAt: -1 }).limit(1).next();
    }
}

/** Run the screener once per UTC day (Redis NX gate) on an interval; returns a stop fn. */
export function startScreenerSchedule(screener: SwingScreener, intervalMs: number): () => void {
    const tick = async (): Promise<void> => {
        try {
            const redis = await getRedisClient();
            const day = new Date().toISOString().slice(0, 10);
            const gate = await redis.set(`market-data:screener:run:${day}`, '1', { NX: true, PX: 25 * 60 * 60_000 });
            if (gate) await screener.run();
        } catch (err) {
            log.warn(`[screener] scheduled run failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return () => clearInterval(timer);
}
