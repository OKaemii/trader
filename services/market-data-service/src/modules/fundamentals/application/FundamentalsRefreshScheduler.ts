// FundamentalsRefreshScheduler — keeps the QMJ cache populated without blocking an HTTP request
// or hammering the provider. A full-universe Yahoo walk takes minutes (one quoteSummary call per
// name); doing it inside the admin endpoint 504s at the ingress, and a single burst trips Yahoo's
// per-IP rate limiter (arming a session cooldown that zeroes the run). So the refresh runs as a
// self-paced background loop: refresh the missing/stale subset, then sleep for a duration chosen
// by how the pass went —
//   • complete coverage      → long idle (re-check staleness ~twice/day)
//   • partial progress        → short sleep, keep accreting
//   • no progress (throttled) → medium sleep past the provider's cooldown, then retry
// The loop is interruptible: `triggerNow()` wakes it immediately (the admin "Refresh" button).
// market-data-service is replicas:1, so an in-process running-guard is sufficient (no cross-pod
// race). Orchestration only — the paced per-ticker fetch + persist lives in FundamentalsCache.

import type { FundamentalsCache } from './FundamentalsCache.ts';
import { log } from '../../../logger.ts';

export interface FundamentalsRefreshSchedulerOpts {
  idleMs?: number;      // sleep once coverage is complete (default 12h)
  retryMs?: number;     // sleep after a no-progress pass; keep > the provider's session cooldown (default 20min)
  progressMs?: number;  // sleep after a partial-progress pass (default 2min)
}

export class FundamentalsRefreshScheduler {
  private running = false;
  private wake: (() => void) | null = null;
  private readonly idleMs: number;
  private readonly retryMs: number;
  private readonly progressMs: number;

  constructor(
    private readonly cache: FundamentalsCache,
    private readonly activeTickers: () => string[],
    opts: FundamentalsRefreshSchedulerOpts = {},
  ) {
    this.idleMs     = opts.idleMs     ?? 12 * 60 * 60_000;
    this.retryMs    = opts.retryMs    ?? 20 * 60_000;
    this.progressMs = opts.progressMs ?? 2 * 60_000;
  }

  /** Start the background loop. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    log.info('[fundamentals] background refresher started');
    void this.loop();
  }

  /** Wake the loop now (e.g. the admin "Refresh" button). Safe to call when idle or mid-sleep. */
  triggerNow(): void { this.wake?.(); }

  private async loop(): Promise<void> {
    while (this.running) {
      let nextMs = this.idleMs;
      try {
        const tickers = this.activeTickers();
        // `refreshed` counts PROGRESS = real `hit` rows + `terminal` tombstones (a tombstone drains a
        // name from the stale set, so it is progress). `outage` is names left to retry because the
        // upstream was unreachable. The "made no progress" warning fires ONLY when nothing advanced AND
        // ≥1 name was a genuine outage — an all-`terminal` residual is "done" (it just got tombstoned
        // and converges to `stale === 0` next pass), NOT a perpetual warning. This is the fix for the
        // `[fundamentals] refresh made no progress (32 stale)` loop on fail-closed / no-EDGAR names.
        const { stale, refreshed, outage } = await this.cache.refreshStale(tickers);
        if (stale === 0) {
          nextMs = this.idleMs;
        } else if (refreshed === 0 && outage > 0) {
          log.warn(`[fundamentals] refresh made no progress (${stale} stale, ${outage} outage; provider unreachable?) — retrying in ${Math.round(this.retryMs / 60_000)}m`);
          nextMs = this.retryMs;
        } else if (outage > 0) {
          // Some names advanced (hits and/or tombstones) but an outage subset remains — keep accreting.
          log.info(`[fundamentals] refreshed ${refreshed}/${stale}; ${outage} outage still pending — continuing`);
          nextMs = this.progressMs;
        } else {
          // No outage left: every stale name resolved to a hit or a tombstone — the set has converged.
          log.info(`[fundamentals] refreshed all ${stale} stale ticker(s) (${refreshed} written/tombstoned) — idle`);
          nextMs = this.idleMs;
        }
      } catch (err) {
        log.warn('[fundamentals] refresh pass failed:', err);
        nextMs = this.retryMs;
      }
      await this.interruptibleSleep(nextMs);
    }
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }
}
