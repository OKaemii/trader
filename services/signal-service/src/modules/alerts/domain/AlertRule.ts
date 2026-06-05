import type { AlertRule } from '@trader/contracts';
import type { Money } from '@trader/shared-types';

export type { AlertRule };

// Upsert input. `id` omitted → a fresh uuid (manual rules); set → deterministic id (derived from a
// trade plan, `${ticker}:${kind}`, so re-saving a plan updates rather than duplicates).
export interface AlertRuleUpsert {
    id?: string | undefined;
    ticker: string;
    kind: AlertRule['kind'];
    direction: AlertRule['direction'];
    level: Money;
    enabled?: boolean | undefined;
    cooldownH?: number | undefined;
    source: AlertRule['source'];
}

export interface IAlertRuleRepository {
    list(filter?: { enabled?: boolean }): Promise<AlertRule[]>;
    get(id: string): Promise<AlertRule | null>;
    upsert(input: AlertRuleUpsert): Promise<AlertRule>;
    remove(id: string): Promise<boolean>;
    markFired(id: string, at: number): Promise<void>;
}
