// CorporateActionsWatcher — closes Gap 1 (plan §8): keeps the seeded daily series re-adjusted when a
// new split/dividend lands, so a corporate action never leaves history on a stale adjustment basis
// (the discontinuity that injects a fake jump into returns/risk — the failure the requirement names).
//
// WHY a watcher is needed even though the storage is already correct: the daily series stores the
// provider's `adjusted_close`, which the provider RETROACTIVELY re-computes across the WHOLE history
// when a new corporate action lands. But the gap-aware daily backfill fetches only MISSING dates and
// the live EOD feed writes only the latest day — so without an explicit trigger a new split silently
// leaves the seeded back-history on the pre-split adjustment basis. The bar `content_hash` already
// includes `adjustedClose` + `adjustmentFactor`, so a forced re-fetch of the now-re-adjusted series
// supersedes each stale row with a new `knowledge_ts` (preserving the bi-temporal as-of contract) —
// the write machinery already works; this is the missing TRIGGER.
//
// Mechanism: bind this watcher's `onNewActions` to CorporateActionsStore — the store is the single
// authority on what is genuinely NEW (it owns the watermark cursors + dedupe), so the watcher fires
// a forced re-backfill (`backfillDailyHistory(…, { forceRefetch: true })`) for exactly the affected
// ticker, exactly when an unseen action is appended. Already-seen events are a no-op (the store never
// calls back). Cost is one forced re-backfill per ticker per corporate action (rare).
//
// Burst handling (a market-wide split day fans out across many tickers at once): the watcher does NOT
// re-adjust inline. It enqueues the ticker into a SERIALISED queue, deduped per ticker, and drains it
// one ticker at a time with a configurable spacing pause — spreading the load so we never fire N
// forced re-fetches concurrently. Throttling/exhaustion is handled below the seam: each forced
// re-backfill is one metered `/eod` call via the shared EodhdCreditLimiter, and on budget exhaustion
// the EODHD client degrades to empty (the limiter never throws out of the client) → backfill writes
// nothing for that ticker → the watcher logs and moves on. Nothing throws into the sync loop.

import type { Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import { backfillDailyHistory } from '../../bars/infrastructure/daily-history.ts';
import type { NewActionsSummary } from './CorporateActionsStore.ts';
import { log } from '../../../logger.ts';

// One forced daily-series re-adjust for a single ticker. Injectable so the unit tests assert the
// trigger without an upstream round-trip; the default binds it to the real gap-aware backfill with
// `forceRefetch: true` (the whole-span re-fetch that picks up the provider's re-adjusted closes).
export type ReAdjustFn = (ticker: string) => Promise<void>;

export interface CorporateActionsWatcherDeps {
  // Lazy resolvers for the Mongo/Redis singletons — mirrors how the rest of the service defers
  // connection access, so the watcher can be constructed at module scope (before the pools connect).
  getDb: () => Promise<Db>;
  getRedis: () => Promise<RedisClientType>;
}

export interface CorporateActionsWatcherOpts {
  // Pause between successive re-adjusts while draining the queue — spreads a market-wide split-day
  // burst so concurrent forced re-fetches don't spike the EODHD budget. Default 1s.
  spacingMs?: number;
  // Override the re-adjust side-effect (tests). Default: backfillDailyHistory(forceRefetch:true).
  reAdjust?: ReAdjustFn;
}

export class CorporateActionsWatcher {
  private readonly spacingMs: number;
  private readonly reAdjust: ReAdjustFn;

  // Dedupe + serialise. `pending` holds tickers awaiting a re-adjust (a Set: a ticker enqueued twice
  // in one burst re-adjusts once). `draining` is the single in-flight drain promise so a second
  // enqueue joins the existing drain rather than starting a parallel one.
  private readonly pending = new Set<string>();
  private draining: Promise<void> | null = null;

  constructor(deps: CorporateActionsWatcherDeps, opts: CorporateActionsWatcherOpts = {}) {
    this.spacingMs = opts.spacingMs ?? 1000;
    this.reAdjust =
      opts.reAdjust ??
      (async (ticker: string): Promise<void> => {
        // forceRefetch: re-download the whole multi-year span so writeBarRevisions supersedes the
        // stale-adjusted rows with the provider's re-adjusted series (new knowledge_ts). Degrades on
        // limiter exhaustion: backfillDailyHistory returns a per-ticker {error} (never throws) and
        // the EODHD client returns empty when the budget is gone — so a re-adjust is at worst a no-op.
        const [db, redis] = await Promise.all([deps.getDb(), deps.getRedis()]);
        const [res] = await backfillDailyHistory(db, redis, [ticker], { forceRefetch: true });
        if (res?.error) {
          log.warn(`[corporate-actions] re-adjust backfill error for ${ticker}: ${res.error}`);
        } else {
          log.info(`[corporate-actions] re-adjusted ${ticker} daily series (${res?.upserted ?? 0} rows superseded/written)`);
        }
      });
  }

  /**
   * The CorporateActionsStore new-event hook. Enqueues a forced daily-series re-adjust for `ticker`
   * (deduped via the pending Set) and kicks the drain. Returns immediately — the store's sync pass is
   * not blocked on the (slow) re-fetch; the drain runs to completion in the background. Never throws
   * (the store treats it as best-effort regardless, but we keep the contract clean here too).
   *
   * The drain start is deferred one microtask so a SYNCHRONOUS burst (the EOD sync loop firing this
   * hook for many tickers back-to-back) fully populates `pending` before the drain pops anything —
   * so a market-wide split day collapses any same-ticker duplicates and batches the distinct names
   * into one serial drain rather than spawning work per enqueue.
   */
  onNewActions = (ticker: string, _summary: NewActionsSummary): void => {
    this.pending.add(ticker);
    if (this.draining === null) {
      this.draining = Promise.resolve()
        .then(() => this.drain())
        .catch((err) => {
          log.warn(`[corporate-actions] re-adjust drain failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  };

  /** Resolves once the current re-adjust queue is fully drained (tests await a deterministic flush). */
  async idle(): Promise<void> {
    if (this.draining) await this.draining;
  }

  // Drain the pending set one ticker at a time, pausing `spacingMs` between successive re-adjusts so a
  // burst is spread rather than fired concurrently. Re-checks `pending` after each item so tickers
  // enqueued mid-drain are picked up by the same drain (no parallel drain spawned).
  private async drain(): Promise<void> {
    try {
      let first = true;
      while (this.pending.size > 0) {
        const ticker = this.pending.values().next().value as string;
        this.pending.delete(ticker);
        if (!first && this.spacingMs > 0) await sleep(this.spacingMs);
        first = false;
        try {
          await this.reAdjust(ticker);
        } catch (err) {
          // Per-ticker isolation: one ticker's failed re-adjust must not stall the rest of the burst.
          log.warn(`[corporate-actions] re-adjust failed for ${ticker}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.draining = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
