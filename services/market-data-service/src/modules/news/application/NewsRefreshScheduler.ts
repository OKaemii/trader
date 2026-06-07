// NewsRefreshScheduler — keeps the news store populated off the request path, mirroring the
// corporate-actions/earnings/fundamentals refreshers. The store's per-ticker TTL gate (and the
// incremental publish-date cursor) makes a steady-state pass near-free: tickers synced within the TTL
// are skipped without a fetch, and a ticker due for a re-check costs one near-empty EODHD news call
// (zero new links ⇒ zero appends). market-data-service is replicas:1, so an in-process guard
// suffices. triggerNow() wakes it (the admin "Refresh" button + a lazy on-symbol-open trigger).
//
// News is fetched LAZILY — this once-daily background pass keeps the active universe warm so the
// Overview panel has recent events without a per-page-load fetch; it is NOT a per-request path.

import type { NewsStore } from './NewsStore.ts';
import { log } from '../../../logger.ts';

export interface NewsRefreshSchedulerOpts {
  idleMs?: number;       // sleep between full passes (default 24h — news is fetched once-daily)
  spacingMs?: number;    // pause between per-ticker syncs to stay under the EODHD rate budget
}

export class NewsRefreshScheduler {
  private running = false;
  private wake: (() => void) | null = null;
  private readonly idleMs: number;
  private readonly spacingMs: number;

  constructor(
    private readonly store: NewsStore,
    private readonly activeTickers: () => string[],
    opts: NewsRefreshSchedulerOpts = {},
  ) {
    this.idleMs = opts.idleMs ?? 24 * 60 * 60_000;
    this.spacingMs = opts.spacingMs ?? 250;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info('[news] background refresher started');
    void this.loop();
  }

  stop(): void { this.running = false; this.wake?.(); }
  triggerNow(): void { this.wake?.(); }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const tickers = this.activeTickers();
        const now = Date.now();
        let fetched = 0, newArticles = 0;
        for (const t of tickers) {
          if (!this.running) break;
          const r = await this.store.syncOne(t, now);
          if (r.fetched) { fetched++; newArticles += r.newArticles; }
          if (this.spacingMs > 0 && r.fetched) await this.sleep(this.spacingMs);
        }
        if (fetched > 0) {
          log.info(`[news] sync pass: ${fetched}/${tickers.length} fetched, +${newArticles} articles`);
        }
      } catch (err) {
        log.warn(`[news] refresh pass failed: ${err instanceof Error ? err.message : String(err)}`);
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
