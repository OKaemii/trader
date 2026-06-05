// AlertWatcher — evaluates enabled price-alert rules on an interval and publishes a `price_alert`
// to ALERTS_TOPIC on a level cross (notification-service routes warning → push + email). Swing
// alerts are EOD-grained, so an hourly tick is ample; the per-rule cooldown prevents re-firing
// while price oscillates around a level. Best-effort: a failed pass logs and retries next tick.

import type { RedisClientType } from 'redis';
import type { Logger } from '@trader/core';
import { publish } from '@trader/shared-redis';
import { ALERTS_TOPIC, type Alert } from '@trader/shared-types';
import type { AlertRule } from '@trader/contracts';
import type { IAlertRuleRepository } from '../domain/AlertRule.ts';
import type { LatestBarReader } from '../infrastructure/LatestBarReader.ts';
import { detectCross, onCooldown, type BarHLC } from './detect.ts';

export class AlertWatcher {
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly repo: IAlertRuleRepository,
        private readonly bars: LatestBarReader,
        private readonly redis: RedisClientType,
        private readonly logger: Logger,
        private readonly intervalMs: number,
        private readonly now: () => number = () => Date.now(),
    ) {}

    start(): void {
        if (this.timer) return;
        void this.tick();
        this.timer = setInterval(() => void this.tick(), this.intervalMs);
        this.logger.info('[alerts] watcher started');
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    /** One evaluation pass. Public for tests + the admin "evaluate now" path. */
    async tick(): Promise<void> {
        try {
            const rules = await this.repo.list({ enabled: true });
            const now = this.now();
            for (const rule of rules) {
                if (onCooldown(rule, now)) continue;
                const bar = await this.bars.latest(rule.ticker);
                if (!bar || !detectCross(rule, bar)) continue;
                await this.fire(rule, bar, now);
            }
        } catch (err) {
            this.logger.warn({ err }, 'alert watch pass failed');
        }
    }

    private async fire(rule: AlertRule, bar: BarHLC, now: number): Promise<void> {
        const verb = rule.direction === 'above' ? 'reached' : 'fell to';
        const alert: Alert = {
            tier: 'warning',
            kind: 'price_alert',
            title: `${rule.ticker} ${rule.kind} ${verb} ${rule.level.amount}`,
            detail: `${rule.ticker} ${verb} ${rule.level.amount} ${rule.level.currency} — latest bar H ${bar.high} / L ${bar.low} / C ${bar.close}`,
            source: 'signal-service',
            ts: now,
            meta: { ticker: rule.ticker, ruleId: rule.id, kind: rule.kind, direction: rule.direction, level: rule.level.amount },
        };
        await publish(this.redis, ALERTS_TOPIC, alert);
        await this.repo.markFired(rule.id, now);
        this.logger.info({ ticker: rule.ticker, kind: rule.kind }, 'price alert fired');
    }
}
