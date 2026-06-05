import type { Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import type { Money } from '@trader/shared-types';
import type { TradePlan } from '@trader/contracts';
import type { ITradePlanRepository, TradePlanUpsert } from '../domain/TradePlan.ts';

interface TradePlanDoc {
    _id: string;            // ticker
    stop?: Money;
    target?: Money;
    note?: string;
    updatedBy: string;
    updatedAt: number;
}

function toPlan(d: TradePlanDoc): TradePlan {
    return {
        ticker: d._id,
        ...(d.stop ? { stop: d.stop } : {}),
        ...(d.target ? { target: d.target } : {}),
        ...(d.note ? { note: d.note } : {}),
        updatedBy: d.updatedBy,
        updatedAt: d.updatedAt,
    };
}

export class MongoTradePlanRepository implements ITradePlanRepository {
    constructor(private readonly db: Db) {}

    private col() {
        return this.db.collection<TradePlanDoc>(COLLECTIONS.TRADE_PLANS);
    }

    async get(ticker: string): Promise<TradePlan | null> {
        const d = await this.col().findOne({ _id: ticker });
        return d ? toPlan(d) : null;
    }

    async list(): Promise<TradePlan[]> {
        const docs = await this.col().find().sort({ _id: 1 }).toArray();
        return docs.map(toPlan);
    }

    async upsert(input: TradePlanUpsert): Promise<TradePlan> {
        const set: Record<string, unknown> = { updatedBy: input.updatedBy, updatedAt: input.updatedAt };
        const unset: Record<string, ''> = {};
        if (input.stop === null) unset.stop = ''; else if (input.stop) set.stop = input.stop;
        if (input.target === null) unset.target = ''; else if (input.target) set.target = input.target;
        if (input.note === null) unset.note = ''; else if (input.note !== undefined) set.note = input.note;

        const update: Record<string, unknown> = { $set: set };
        if (Object.keys(unset).length > 0) update.$unset = unset;

        await this.col().updateOne({ _id: input.ticker }, update, { upsert: true });
        // Read-back so the response reflects post-merge state (incl. fields left untouched).
        const saved = await this.get(input.ticker);
        if (!saved) throw new Error(`trade plan upsert for ${input.ticker} did not persist`);
        return saved;
    }

    async remove(ticker: string): Promise<boolean> {
        const r = await this.col().deleteOne({ _id: ticker });
        return (r.deletedCount ?? 0) > 0;
    }
}
