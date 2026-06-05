import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import type { Money } from '@trader/shared-types';
import type { AlertRule } from '@trader/contracts';
import type { IAlertRuleRepository, AlertRuleUpsert } from '../domain/AlertRule.ts';

interface AlertRuleDoc {
    _id: string;
    ticker: string;
    kind: AlertRule['kind'];
    direction: AlertRule['direction'];
    level: Money;
    enabled: boolean;
    cooldownH: number;
    lastFiredAt?: number;
    source: AlertRule['source'];
    updatedAt: number;
}

function toRule(d: AlertRuleDoc): AlertRule {
    return {
        id: d._id, ticker: d.ticker, kind: d.kind, direction: d.direction, level: d.level,
        enabled: d.enabled, cooldownH: d.cooldownH, source: d.source, updatedAt: d.updatedAt,
        ...(d.lastFiredAt !== undefined ? { lastFiredAt: d.lastFiredAt } : {}),
    };
}

export class MongoAlertRuleRepository implements IAlertRuleRepository {
    constructor(private readonly db: Db) {}

    private col() {
        return this.db.collection<AlertRuleDoc>(COLLECTIONS.ALERT_RULES);
    }

    async list(filter?: { enabled?: boolean }): Promise<AlertRule[]> {
        const q = filter?.enabled !== undefined ? { enabled: filter.enabled } : {};
        const docs = await this.col().find(q).sort({ ticker: 1 }).toArray();
        return docs.map(toRule);
    }

    async get(id: string): Promise<AlertRule | null> {
        const d = await this.col().findOne({ _id: id });
        return d ? toRule(d) : null;
    }

    async upsert(input: AlertRuleUpsert): Promise<AlertRule> {
        const id = input.id ?? randomUUID();
        // _id is set by the filter on insert; never put it in $set. lastFiredAt is intentionally
        // absent from $set so an edit preserves the existing cooldown rather than re-arming it.
        const set = {
            ticker: input.ticker, kind: input.kind, direction: input.direction, level: input.level,
            enabled: input.enabled ?? true, cooldownH: input.cooldownH ?? 24,
            source: input.source, updatedAt: Date.now(),
        };
        await this.col().updateOne({ _id: id }, { $set: set }, { upsert: true });
        const saved = await this.get(id);
        if (!saved) throw new Error(`alert rule upsert for ${id} did not persist`);
        return saved;
    }

    async remove(id: string): Promise<boolean> {
        const r = await this.col().deleteOne({ _id: id });
        return (r.deletedCount ?? 0) > 0;
    }

    async markFired(id: string, at: number): Promise<void> {
        await this.col().updateOne({ _id: id }, { $set: { lastFiredAt: at } });
    }
}
