// Pure price-alert logic: cross detection, cooldown, and trade-plan → rule derivation. Kept pure
// (no IO) so the swing-trading alert behaviour is unit-tested independently of Mongo / Redis.

import type { AlertRule } from '@trader/contracts';
import type { Money } from '@trader/shared-types';

export interface BarHLC { high: number; low: number; close: number; }

/**
 * Did the latest bar's range cross the rule's level? 'above' (entry/target) fires when the bar's
 * HIGH reaches the level; 'below' (stop) fires when the bar's LOW reaches it. Using high/low (not
 * just close) catches an intraday touch that reverted by the close — the stop was still hit.
 */
export function detectCross(rule: Pick<AlertRule, 'direction' | 'level'>, bar: BarHLC): boolean {
    return rule.direction === 'above' ? bar.high >= rule.level.amount : bar.low <= rule.level.amount;
}

/** Within the per-rule cooldown window (so it must not re-fire)? Never on cooldown before first fire. */
export function onCooldown(rule: Pick<AlertRule, 'cooldownH' | 'lastFiredAt'>, now: number): boolean {
    if (rule.lastFiredAt == null) return false;
    return now - rule.lastFiredAt < rule.cooldownH * 3_600_000;
}

export interface PlanForDerive { ticker: string; stop?: Money | undefined; target?: Money | undefined; }
export interface DerivedRule {
    id: string;
    ticker: string;
    kind: 'stop' | 'target';
    direction: 'above' | 'below';
    level: Money;
    source: 'tradeplan';
}

/**
 * Alert rules implied by a trade plan: a stop → a 'below' rule, a target → an 'above' rule, each
 * with a deterministic id. A missing stop/target yields a removeId so clearing a plan field also
 * clears its derived rule.
 */
export function deriveRulesFromPlan(plan: PlanForDerive): { upsert: DerivedRule[]; removeIds: string[] } {
    const upsert: DerivedRule[] = [];
    const removeIds: string[] = [];
    if (plan.stop) upsert.push({ id: `${plan.ticker}:stop`, ticker: plan.ticker, kind: 'stop', direction: 'below', level: plan.stop, source: 'tradeplan' });
    else removeIds.push(`${plan.ticker}:stop`);
    if (plan.target) upsert.push({ id: `${plan.ticker}:target`, ticker: plan.ticker, kind: 'target', direction: 'above', level: plan.target, source: 'tradeplan' });
    else removeIds.push(`${plan.ticker}:target`);
    return { upsert, removeIds };
}
