// CorporateActionsRefreshScheduler — keeps corporate_actions populated off the request path,
// mirroring the earnings/fundamentals refreshers. The store's per-ticker TTL gate (and the
// incremental `from` cursor) makes a steady-state pass near-free: tickers synced within the TTL are
// skipped without a fetch, and a ticker due for a re-check costs one near-empty EODHD call (zero new
// events ⇒ zero appends). market-data-service is replicas:1, so an in-process guard suffices.
// triggerNow() wakes it (the admin "Refresh" button).

import type { CorporateActionsStore } from './CorporateActionsStore.ts';
import { log } from '../../../logger.ts';

export interface CorporateActionsRefreshSchedulerOpts {
  idleMs?: number;       // sleep between full passes (default 24h — actions land at most quarterly)
  spacingMs?: number;    // pause between per-ticker syncs to stay under the EODHD rate budget
}

export class CorporateActionsRefreshScheduler {
  private running = false;
  private wake: (() => void) | null = null;
  private readonly idleMs: number;
  private readonly spacingMs: number;

  constructor(
    private readonly store: CorporateActionsStore,
    private readonly activeTickers: () => string[],
    opts: CorporateActionsRefreshSchedulerOpts = {},
  ) {
    this.idleMs = opts.idleMs ?? 24 * 60 * 60_000;
    this.spacingMs = opts.spacingMs ?? 250;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info('[corporate-actions] background refresher started');
    void this.loop();
  }

  stop(): void { this.running = false; this.wake?.(); }
  triggerNow(): void { this.wake?.(); }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const tickers = this.activeTickers();
        const now = Date.now();
        let fetched = 0, newDividends = 0, newSplits = 0;
        for (const t of tickers) {
          if (!this.running) break;
          const r = await this.store.syncOne(t, now);
          if (r.fetched) { fetched++; newDividends += r.newDividends; newSplits += r.newSplits; }
          if (this.spacingMs > 0 && r.fetched) await this.sleep(this.spacingMs);
        }
        if (fetched > 0) {
          log.info(`[corporate-actions] sync pass: ${fetched}/${tickers.length} fetched, +${newDividends} dividends, +${newSplits} splits`);
        }
      } catch (err) {
        log.warn(`[corporate-actions] refresh pass failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.interruptibleSleep(this.idleMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(t); this.wake = null; resolve(); };
    });
  }
}
