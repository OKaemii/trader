// ConsensusStore — the two Pipeline C Mongo stores (plan ## Task 12):
//   consensus_estimate(ticker, fiscal_period, metric, consensus, num_analysts, snapshot_date)
//   earnings_surprise(ticker, fiscal_period, actual_eps, consensus_eps, surprise_pct)
//
// Both are written by refresh() from a ConsensusProvider, and read back honestly. With the SHIPPED
// StubConsensusProvider the provider returns {} for every name, so refresh() writes NOTHING and both
// stores stay EMPTY — the honest "requires consensus — not sourced" state. The surprise row is derived
// ONLY when a consensus_eps row and a realised actual coexist for the same (ticker, fiscal_period),
// via the pure surprisePct(); there is no mechanical-proxy path that could fabricate a surprise.
//
// Identity keying mirrors EarningsStore / the other market-data stores (Thread A): documents carry the
// bare (symbol, market) identity, never the concatenated T212 ticker. Each row's `_id` is the composite
// `${symbol}:${market}:${fiscal_period}[:${metric}]` and `symbol`/`market` are also queryable fields.
// Every write/read bridges the T212 ticker → identity at the Mongo boundary fail-soft (an un-routable
// ticker is skipped, never throwing the batch).

import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import type { Collection } from 'mongodb';
import type { ConsensusProvider } from '../infrastructure/ConsensusProvider.ts';
import { surprisePct } from './surprise.ts';
import { tryIdentityOf, tickerOf } from '../../../shared/identity.ts';

/** A stored forward analyst-consensus estimate. `_id` = `<symbol>:<market>:<fiscal_period>:<metric>`. */
export interface ConsensusEstimateDoc {
    _id: string;
    symbol: string;
    market: string;
    fiscalPeriod: string;
    metric: string;
    consensus: number;
    numAnalysts: number;
    snapshotDate: number; // UTC ms — point-in-time the estimate was knowable
    source: string;
    updatedAt: number;
}

/** A stored realised earnings surprise. `_id` = `<symbol>:<market>:<fiscal_period>`. `surprisePct` is
 *  null when the consensus denominator was zero (fail-closed — never a fabricated 0%). */
export interface EarningsSurpriseDoc {
    _id: string;
    symbol: string;
    market: string;
    fiscalPeriod: string;
    actualEps: number;
    consensusEps: number;
    surprisePct: number | null;
    source: string;
    updatedAt: number;
}

export class ConsensusStore {
    constructor(
        private readonly provider: ConsensusProvider,
        private readonly source: string,
    ) {}

    private async estimates(): Promise<Collection<ConsensusEstimateDoc>> {
        return (await getMongoDb()).collection<ConsensusEstimateDoc>(COLLECTIONS.CONSENSUS_ESTIMATE);
    }

    private async surprises(): Promise<Collection<EarningsSurpriseDoc>> {
        return (await getMongoDb()).collection<EarningsSurpriseDoc>(COLLECTIONS.EARNINGS_SURPRISE);
    }

    /** Stored consensus estimates for `ticker`, newest snapshot first. Empty with the stub provider.
     *  The returned rows carry a re-derived `ticker` so the route renders the T212 form. */
    async estimatesFor(ticker: string): Promise<Array<ConsensusEstimateDoc & { ticker: string }>> {
        const id = tryIdentityOf(ticker);
        if (id === null) return [];
        const docs = await (await this.estimates())
            .find({ symbol: id.symbol, market: id.market })
            .sort({ snapshotDate: -1 })
            .toArray();
        return docs.map((d) => ({ ...d, ticker: tickerOf(d.symbol, d.market) }));
    }

    /** Stored earnings surprises for `ticker`, newest fiscal period first. Empty with the stub. */
    async surprisesFor(ticker: string): Promise<Array<EarningsSurpriseDoc & { ticker: string }>> {
        const id = tryIdentityOf(ticker);
        if (id === null) return [];
        const docs = await (await this.surprises())
            .find({ symbol: id.symbol, market: id.market })
            .sort({ fiscalPeriod: -1 })
            .toArray();
        return docs.map((d) => ({ ...d, ticker: tickerOf(d.symbol, d.market) }));
    }

    /** Row counts for the honest coverage read — both 0 while Pipeline C is stubbed. */
    async coverage(): Promise<{ estimates: number; surprises: number }> {
        const [estimates, surprises] = await Promise.all([
            (await this.estimates()).countDocuments({}),
            (await this.surprises()).countDocuments({}),
        ]);
        return { estimates, surprises };
    }

    /**
     * Pull consensus for `tickers` from the provider and persist estimates + derived surprises.
     * Returns counts so a caller can pace/log. With the stub the provider returns {} → both counts 0
     * (no write). A surprise is derived ONLY where a consensus EPS estimate AND a realised actual EPS
     * coexist for the same (ticker, fiscal_period) — surprisePct() is the only path to a surprise row,
     * so no mechanical proxy can ever land here. An un-routable ticker is skipped fail-soft.
     */
    async refresh(tickers: string[]): Promise<{ estimates: number; surprises: number }> {
        if (tickers.length === 0) return { estimates: 0, surprises: 0 };
        const fetched = await this.provider.fetch(tickers);
        const at = Date.now();
        let estimatesWritten = 0;
        let surprisesWritten = 0;

        for (const ticker of tickers) {
            const data = fetched[ticker];
            if (!data) continue; // omitted by the provider — no coverage; leave any prior rows untouched
            const id = tryIdentityOf(ticker);
            if (id === null) continue;

            const estColl = await this.estimates();
            // Index EPS consensus by fiscal period so a matching actual can derive the surprise.
            const epsByPeriod = new Map<string, number>();
            for (const est of data.estimates) {
                await estColl.updateOne(
                    { _id: `${id.symbol}:${id.market}:${est.fiscalPeriod}:${est.metric}` },
                    { $set: {
                        symbol: id.symbol, market: id.market,
                        fiscalPeriod: est.fiscalPeriod, metric: est.metric,
                        consensus: est.consensus, numAnalysts: est.numAnalysts,
                        snapshotDate: est.snapshotDate, source: this.source, updatedAt: at,
                    } },
                    { upsert: true },
                );
                estimatesWritten++;
                if (est.metric === 'eps') epsByPeriod.set(est.fiscalPeriod, est.consensus);
            }

            const surpColl = await this.surprises();
            for (const actual of data.actuals) {
                const consensusEps = epsByPeriod.get(actual.fiscalPeriod);
                if (consensusEps === undefined) continue; // no consensus → NO surprise (never faked)
                await surpColl.updateOne(
                    { _id: `${id.symbol}:${id.market}:${actual.fiscalPeriod}` },
                    { $set: {
                        symbol: id.symbol, market: id.market, fiscalPeriod: actual.fiscalPeriod,
                        actualEps: actual.actualEps, consensusEps,
                        surprisePct: surprisePct({ actualEps: actual.actualEps, consensusEps }),
                        source: this.source, updatedAt: at,
                    } },
                    { upsert: true },
                );
                surprisesWritten++;
            }
        }
        return { estimates: estimatesWritten, surprises: surprisesWritten };
    }
}
