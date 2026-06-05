// EarningsStore — earnings_calendar with a weekly TTL refresh. Earnings dates drift (companies
// confirm/move report dates), so a row older than ttlMs is re-fetched. Reads (upcoming, overlap)
// never refresh — they serve whatever the background scheduler has accreted.

import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import type { Collection } from 'mongodb';
import type { EarningsProvider } from '../infrastructure/EarningsProvider.ts';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface EarningsDoc {
    _id: string;                 // ticker
    nextEarningsDate?: number;   // UTC ms
    dividendDate?: number;       // UTC ms
    source: string;
    asOf: number;
    updatedAt: number;
}

export class EarningsStore {
    constructor(
        private readonly provider: EarningsProvider,
        private readonly source: string,
        private readonly ttlMs = WEEK_MS,
    ) {}

    private async coll(): Promise<Collection<EarningsDoc>> {
        return (await getMongoDb()).collection<EarningsDoc>(COLLECTIONS.EARNINGS_CALENDAR);
    }

    /** Cached docs for `tickers` (no provider refresh) — backs the overlap read. */
    async peek(tickers: string[]): Promise<Record<string, EarningsDoc>> {
        if (tickers.length === 0) return {};
        const docs = await (await this.coll()).find({ _id: { $in: tickers } }).toArray();
        return Object.fromEntries(docs.map((d) => [d._id, d]));
    }

    /** Known earnings with a date in [now, now + days], ascending. */
    async upcoming(days: number, now: number): Promise<EarningsDoc[]> {
        const horizon = now + days * 24 * 60 * 60 * 1000;
        return (await this.coll())
            .find({ nextEarningsDate: { $gte: now, $lte: horizon } })
            .sort({ nextEarningsDate: 1 })
            .toArray();
    }

    async coverage(): Promise<{ count: number; withEarningsDate: number }> {
        const coll = await this.coll();
        const [count, withEarningsDate] = await Promise.all([
            coll.countDocuments({}),
            coll.countDocuments({ nextEarningsDate: { $exists: true } }),
        ]);
        return { count, withEarningsDate };
    }

    /** Refresh the missing/stale subset; returns counts so the scheduler can pace. */
    async refreshStale(tickers: string[]): Promise<{ stale: number; refreshed: number }> {
        if (tickers.length === 0) return { stale: 0, refreshed: 0 };
        const coll = await this.coll();
        const existing = await coll.find({ _id: { $in: tickers } }, { projection: { asOf: 1 } }).toArray();
        const asOf = new Map(existing.map((d) => [d._id, d.asOf]));
        const now = Date.now();
        const stale = tickers.filter((t) => { const a = asOf.get(t); return a == null || now - a > this.ttlMs; });
        if (stale.length === 0) return { stale: 0, refreshed: 0 };

        const fetched = await this.provider.fetch(stale);
        const at = Date.now();
        let refreshed = 0;
        for (const ticker of stale) {
            const info = fetched[ticker];
            if (!info) continue;            // unknown this pass — leave any prior doc untouched
            const set: Record<string, unknown> = { source: this.source, asOf: at, updatedAt: at };
            const unset: Record<string, ''> = {};
            if (info.nextEarningsDate !== undefined) set.nextEarningsDate = info.nextEarningsDate; else unset.nextEarningsDate = '';
            if (info.dividendDate !== undefined) set.dividendDate = info.dividendDate; else unset.dividendDate = '';
            const update: Record<string, unknown> = { $set: set };
            if (Object.keys(unset).length > 0) update.$unset = unset;
            await coll.updateOne({ _id: ticker }, update, { upsert: true });
            refreshed++;
        }
        return { stale: stale.length, refreshed };
    }
}
