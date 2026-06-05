// EarningsRefreshScheduler — keeps earnings_calendar populated off the request path, mirroring the
// fundamentals refresher. The store's weekly TTL gates real work, so the loop just re-checks
// staleness on a daily idle, accreting partial progress and backing off past Yahoo's cooldown
// when a pass makes no progress. market-data-service is replicas:1, so an in-process guard is
// enough. triggerNow() wakes it (the admin "Refresh" button).

import type { EarningsStore } from './EarningsStore.ts';
import { log } from '../../../logger.ts';

export interface EarningsRefreshSchedulerOpts {
    idleMs?: number;       // re-check staleness when coverage is complete (default 24h)
    retryMs?: number;      // sleep after a no-progress pass; keep > Yahoo's session cooldown (default 20min)
    progressMs?: number;   // sleep after a partial-progress pass (default 1min)
}

export class EarningsRefreshScheduler {
    private running = false;
    private wake: (() => void) | null = null;
    private readonly idleMs: number;
    private readonly retryMs: number;
    private readonly progressMs: number;

    constructor(
        private readonly store: EarningsStore,
        private readonly activeTickers: () => string[],
        opts: EarningsRefreshSchedulerOpts = {},
    ) {
        this.idleMs = opts.idleMs ?? 24 * 60 * 60_000;
        this.retryMs = opts.retryMs ?? 20 * 60_000;
        this.progressMs = opts.progressMs ?? 60_000;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        log.info('[earnings] background refresher started');
        void this.loop();
    }

    stop(): void { this.running = false; this.wake?.(); }
    triggerNow(): void { this.wake?.(); }

    private async loop(): Promise<void> {
        while (this.running) {
            let sleepMs = this.idleMs;
            try {
                const { stale, refreshed } = await this.store.refreshStale(this.activeTickers());
                if (stale === 0) sleepMs = this.idleMs;
                else if (refreshed > 0) sleepMs = this.progressMs;
                else sleepMs = this.retryMs;
            } catch (err) {
                log.warn(`[earnings] refresh pass failed: ${err instanceof Error ? err.message : String(err)}`);
                sleepMs = this.retryMs;
            }
            await this.interruptibleSleep(sleepMs);
        }
    }

    private interruptibleSleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const t = setTimeout(() => { this.wake = null; resolve(); }, ms);
            this.wake = () => { clearTimeout(t); this.wake = null; resolve(); };
        });
    }
}
