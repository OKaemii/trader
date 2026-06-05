import type { Money } from '@trader/shared-types';
import type { TradePlan } from '@trader/contracts';

export type { TradePlan };

// Upsert input: stop/target/note each tri-state — `undefined` leaves the field unchanged,
// `null` clears it, a value sets it. Mirrors the portal_* nullable-override convention.
export interface TradePlanUpsert {
    ticker: string;
    stop?: Money | null | undefined;
    target?: Money | null | undefined;
    note?: string | null | undefined;
    updatedBy: string;
    updatedAt: number;
}

export interface ITradePlanRepository {
    get(ticker: string): Promise<TradePlan | null>;
    list(): Promise<TradePlan[]>;
    upsert(input: TradePlanUpsert): Promise<TradePlan>;
    remove(ticker: string): Promise<boolean>;
}
