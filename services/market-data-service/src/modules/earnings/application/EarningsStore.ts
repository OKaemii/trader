// EarningsStore — earnings_calendar with a weekly TTL refresh. Earnings dates drift (companies
// confirm/move report dates), so a row older than ttlMs is re-fetched. Reads (upcoming, overlap)
// never refresh — they serve whatever the background scheduler has accreted.

import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import type { Collection } from 'mongodb';
import type { EarningsProvider } from '../infrastructure/EarningsProvider.ts';
import { tryIdentityOf, tryIdOf, idOf, tickerOf } from '../../../shared/identity.ts';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// NOTE: earnings_calendar is VESTIGIAL post-Yahoo-removal (Thread C / Task 20) — the wired provider
// is StubEarningsProvider, which returns {} for every name, so refreshStale never writes a row and
// the store stays empty. The (symbol, market) keying below is migrated for a future PIT-backed
// earnings writer's sake; today every read returns nothing.
export interface EarningsDoc {
    _id: string;                 // '<symbol>:<market>' (the bare-identity composite key since Task 16b)
    symbol: string;              // bare exchange symbol
    market: string;              // 'US' | 'LSE'
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

    /** Cached docs for `tickers` (no provider refresh) — backs the overlap read. Keyed on the
     *  (symbol, market) composite `_id`; the returned map is re-keyed to the requested T212 ticker. */
    async peek(tickers: string[]): Promise<Record<string, EarningsDoc>> {
        if (tickers.length === 0) return {};
        const idToTicker = new Map<string, string>();
        for (const t of tickers) { const id = tryIdOf(t); if (id !== null) idToTicker.set(id, t); }
        if (idToTicker.size === 0) return {};
        const docs = await (await this.coll()).find({ _id: { $in: [...idToTicker.keys()] } }).toArray();
        const out: Record<string, EarningsDoc> = {};
        for (const d of docs) { const t = idToTicker.get(d._id); if (t !== undefined) out[t] = d; }
        return out;
    }

    /** Known earnings with a date in [now, now + days], ascending. Each doc gains a re-derived
     *  `ticker` (from its stored symbol/market) so the route renders the T212 ticker as before. */
    async upcoming(days: number, now: number): Promise<Array<EarningsDoc & { ticker: string }>> {
        const horizon = now + days * 24 * 60 * 60 * 1000;
        const docs = await (await this.coll())
            .find({ nextEarningsDate: { $gte: now, $lte: horizon } })
            .sort({ nextEarningsDate: 1 })
            .toArray();
        const out: Array<EarningsDoc & { ticker: string }> = [];
        for (const d of docs) {
            if (d.symbol == null || d.market == null) continue;
            out.push({ ...d, ticker: tickerOf(d.symbol, d.market) });
        }
        return out;
    }

    async coverage(): Promise<{ count: number; withEarningsDate: number }> {
        const coll = await this.coll();
        const [count, withEarningsDate] = await Promise.all([
            coll.countDocuments({}),
            coll.countDocuments({ nextEarningsDate: { $exists: true } }),
        ]);
        return { count, withEarningsDate };
    }

    /** Refresh the missing/stale subset; returns counts so the scheduler can pace. Keyed on the
     *  (symbol, market) composite `_id` since Task 16b (an un-routable name is skipped, fail-soft). */
    async refreshStale(tickers: string[]): Promise<{ stale: number; refreshed: number }> {
        if (tickers.length === 0) return { stale: 0, refreshed: 0 };
        const coll = await this.coll();
        const idToTicker = new Map<string, string>();
        for (const t of tickers) { const id = tryIdOf(t); if (id !== null) idToTicker.set(id, t); }
        if (idToTicker.size === 0) return { stale: 0, refreshed: 0 };
        const existing = await coll.find({ _id: { $in: [...idToTicker.keys()] } }, { projection: { asOf: 1 } }).toArray();
        const asOf = new Map(existing.map((d) => [d._id, d.asOf]));
        const now = Date.now();
        const stale = [...idToTicker.entries()]
            .filter(([id]) => { const a = asOf.get(id); return a == null || now - a > this.ttlMs; })
            .map(([, ticker]) => ticker);
        if (stale.length === 0) return { stale: 0, refreshed: 0 };

        const fetched = await this.provider.fetch(stale);
        const at = Date.now();
        let refreshed = 0;
        for (const ticker of stale) {
            const info = fetched[ticker];
            if (!info) continue;            // unknown this pass — leave any prior doc untouched
            const identity = tryIdentityOf(ticker);
            if (identity === null) continue;
            const set: Record<string, unknown> = { symbol: identity.symbol, market: identity.market, source: this.source, asOf: at, updatedAt: at };
            const unset: Record<string, ''> = {};
            if (info.nextEarningsDate !== undefined) set.nextEarningsDate = info.nextEarningsDate; else unset.nextEarningsDate = '';
            if (info.dividendDate !== undefined) set.dividendDate = info.dividendDate; else unset.dividendDate = '';
            const update: Record<string, unknown> = { $set: set };
            if (Object.keys(unset).length > 0) update.$unset = unset;
            await coll.updateOne({ _id: idOf(identity) }, update, { upsert: true });
            refreshed++;
        }
        return { stale: stale.length, refreshed };
    }
}
