import type { Logger } from '@trader/core';
import type { TradeSignalDTO } from '@trader/shared-types';

const DEFAULT_DEBOUNCE_MS = 30_000;          // 30s of inactivity → flush
const CYCLE_BUCKET_MS     = 60_000;          // signals within same 60s window are one cycle

// CycleAnalysisBatcher — collects per-signal arrivals on signals:trade and groups them
// into "cycles" so we can fire ONE enriched analysis email per strategy cycle (covering
// all picks together) instead of N small emails. The per-signal quick-email path
// (NotificationLoop) is unaffected; this is a parallel batched channel.
//
// Cycle key:    `${strategy_id}:${floor(signal.timestamp / CYCLE_BUCKET_MS)}`
//    Signals from the same GenerateSignals.execute() share a timestamp (computed once
//    per cycle), so bucketing by 60s collapses them while keeping cycles minutes apart
//    (15m intraday / daily) distinct.
// Flush rule:   `debounceMs` ms after the LAST arrival into the cycle. A 30s window
//    comfortably covers the dispatcher staging + signal-service emission burst (~10-15s
//    for a 98-signal cycle) without delaying the email noticeably.
// Memory:       per-process, no persistence. A pod restart loses an in-flight batch but
//    the per-signal emails already fired, so the user only loses the consolidated digest
//    for that one cycle. Acceptable.
export interface CycleBatch {
    cycleKey:    string;
    strategyId:  string;
    cycleTs:     number;        // bucketed timestamp (ms since epoch, aligned to bucket start)
    signals:     TradeSignalDTO[];
    firstSeenAt: number;
    lastSeenAt:  number;
}

export interface CycleAnalysisBatcherOptions {
    onFlush:     (batch: CycleBatch) => Promise<void>;
    logger:      Logger;
    debounceMs?: number;
    now?:        () => number;
}

export class CycleAnalysisBatcher {
    private readonly buckets   = new Map<string, CycleBatch>();
    private readonly timers    = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly debounceMs: number;
    private readonly now:        () => number;
    private stopped = false;

    constructor(private readonly opts: CycleAnalysisBatcherOptions) {
        this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        this.now        = opts.now        ?? (() => Date.now());
    }

    add(signal: TradeSignalDTO): void {
        if (this.stopped) return;
        const cycleTs  = Math.floor(signal.timestamp / CYCLE_BUCKET_MS) * CYCLE_BUCKET_MS;
        const cycleKey = `${signal.strategy_id}:${cycleTs}`;
        const t        = this.now();
        let batch = this.buckets.get(cycleKey);
        if (!batch) {
            batch = {
                cycleKey, cycleTs,
                strategyId:  signal.strategy_id,
                signals:     [],
                firstSeenAt: t,
                lastSeenAt:  t,
            };
            this.buckets.set(cycleKey, batch);
        }
        batch.signals.push(signal);
        batch.lastSeenAt = t;

        // Reset the debounce timer — every new arrival pushes the flush deadline forward.
        const existingTimer = this.timers.get(cycleKey);
        if (existingTimer) clearTimeout(existingTimer);
        this.timers.set(cycleKey, setTimeout(() => this.flush(cycleKey).catch((err) => {
            this.opts.logger.error({ err, cycleKey }, 'cycle-batcher: flush failed');
        }), this.debounceMs));
    }

    private async flush(cycleKey: string): Promise<void> {
        const batch = this.buckets.get(cycleKey);
        if (!batch) return;
        this.buckets.delete(cycleKey);
        this.timers.delete(cycleKey);
        this.opts.logger.info({
            cycleKey,
            n:            batch.signals.length,
            tickers:      batch.signals.map((s) => s.ticker).slice(0, 8),
            firstSeenAt:  batch.firstSeenAt,
            ageMs:        this.now() - batch.firstSeenAt,
        }, 'cycle-batcher: flushing');
        await this.opts.onFlush(batch);
    }

    // Drain remaining batches on shutdown so we don't lose the last cycle's digest.
    async drain(): Promise<void> {
        this.stopped = true;
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
        const keys = Array.from(this.buckets.keys());
        for (const k of keys) await this.flush(k);
    }
}
