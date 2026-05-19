import type { Logger } from '@trader/core';
import type { TradeSignalDTO } from '@trader/shared-types';
import {
    type ExchangeCalendar,
    type Market,
    marketStateOf,
    nextClose,
    nyseCalendar,
    lseCalendar,
    type HolidayCache,
} from '@trader/shared-calendar';

// EOD partitioning bucket. Mirrors shared-calendar's Market but adds OTHER for tickers
// that don't carry a US / LSE suffix — those flush via the trailing-debounce safety
// valve (no calendar = nothing to query). Localised so we don't pollute shared-calendar.
type EodMarket = Market | 'OTHER';

// One of the four cadences strategies advertise via StrategyOutput.report_cadence.
// Strategies without a declared cadence default to 'per_cycle' (the safe baseline that
// matches pre-cadence-aware behaviour for daily rebalances).
export type Cadence = 'per_cycle' | 'hourly' | 'four_hourly' | 'eod';

const CADENCE_TO_WINDOW_MS: Record<Exclude<Cadence, 'eod'>, number> = {
    per_cycle:   60_000,            // 60s — one rebalance burst worth of signals
    hourly:      60 * 60_000,
    four_hourly: 4 * 60 * 60_000,
};

// Trailing-debounce safety valve. If signals keep arriving past the window's end
// (e.g. the dispatcher emitting late), the flush pushes back so the operator gets one
// coherent digest instead of two split halves. Bounded so a perpetually-noisy stream
// can't indefinitely defer the flush.
const TRAILING_DEBOUNCE_MS = 5 * 60_000;

// EOD bucket timer cadence. Each tick checks the tracked exchanges' state and flushes
// EOD buckets whose session has closed. 60s is generous — we tolerate up to one minute
// of latency past close, which is invisible operationally and avoids hot-spinning.
const EOD_TIMER_INTERVAL_MS = 60_000;

// CycleAnalysisBatcher — collects per-signal arrivals on signals:trade and groups them
// into windowed buckets keyed by `(strategy_id, cadence, bucketIndex)`. Emits ONE
// enriched analysis email per bucket. The per-signal quick-email path (NotificationLoop)
// is unaffected; this is a parallel batched channel.
//
// Cycle keys:
//   per_cycle    → `${strategy_id}:per_cycle:${floor(signal.timestamp / 60s)}`     (~one cycle)
//   hourly       → `${strategy_id}:hourly:${floor(signal.timestamp / 1h)}`         (merges multiple cycles within the hour)
//   four_hourly  → `${strategy_id}:four_hourly:${floor(signal.timestamp / 4h)}`
//   eod          → `${strategy_id}:eod:${market}:${sessionDateUTC}`                (one per (strategy × market × day))
//
// Flush rules:
//   non-EOD: `flushAt = max(bucketEndMs, lastSeenAt + 5min)`. The bucket fires at the
//      window boundary (predictable: top-of-hour for hourly, top-of-4h for four_hourly,
//      top-of-minute for per_cycle); the 5min trailing-debounce safety valve catches
//      late stragglers without splitting a cycle's burst across two emails.
//   eod: timer-driven. A central 60s ticker checks each tracked exchange's market state
//      via shared-calendar.marketStateOf; on transition to CLOSED, the EOD bucket for
//      that (strategy × market × sessionDate) is flushed.
//
// Dedup: multiple cycles merging into the same bucket may re-emit signals with the same
// id (e.g. a re-fire after a Mongo blip). Bucket de-dupes by signal.id on add.
//
// Memory: per-process, no persistence. A pod restart loses an in-flight batch but the
// per-signal quick emails already fired, so the user only loses the consolidated digest
// for that bucket. Acceptable.

export interface CycleBatch {
    cycleKey:    string;
    strategyId:  string;
    cadence:     Cadence;
    market?:     EodMarket;          // EOD only
    cycleTs:     number;             // bucketed timestamp (ms since epoch)
    signals:     TradeSignalDTO[];
    firstSeenAt: number;
    lastSeenAt:  number;
}

export interface CycleAnalysisBatcherOptions {
    onFlush: (batch: CycleBatch) => Promise<void>;
    logger:  Logger;
    // EOD calendars by market. If absent, EOD signals fall back to flushing on the
    // trailing-debounce safety valve only (acceptable for tests).
    calendars?: Partial<Record<Market, ExchangeCalendar>>;
    // Reporting-cadence override applied when the strategy advertises an intraday
    // cadence. 'per_cycle' strategies (daily rebalances) ignore the override entirely.
    // Intraday strategies respect the override but can't be flipped BACK to per_cycle
    // — that would reintroduce the 12-emails-per-hour problem the cadence design fixes.
    intradayOverride?: Cadence;
    // Trailing-debounce safety valve. Overridable for tests so we don't have to wait
    // 5 minutes of wall-clock per assertion.
    trailingDebounceMs?: number;
    // EOD timer cadence. Overridable for tests.
    eodTimerIntervalMs?: number;
    // Wall-clock injection — tests pass a fake clock.
    now?: () => number;
}

export class CycleAnalysisBatcher {
    private readonly buckets         = new Map<string, CycleBatch>();
    private readonly timers          = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly flushedEodKeys  = new Set<string>();   // prevent double-flush within session
    private readonly calendars:           Partial<Record<Market, ExchangeCalendar>>;
    private readonly intradayOverride:    Cadence | undefined;
    private readonly trailingDebounceMs:  number;
    private readonly eodTimerIntervalMs:  number;
    private readonly now:                 () => number;
    private eodTicker:    ReturnType<typeof setInterval> | undefined;
    private stopped = false;

    constructor(private readonly opts: CycleAnalysisBatcherOptions) {
        this.calendars          = opts.calendars          ?? {};
        this.intradayOverride   = opts.intradayOverride;
        this.trailingDebounceMs = opts.trailingDebounceMs ?? TRAILING_DEBOUNCE_MS;
        this.eodTimerIntervalMs = opts.eodTimerIntervalMs ?? EOD_TIMER_INTERVAL_MS;
        this.now                = opts.now                ?? (() => Date.now());
        // EOD ticker is lazy — only started when the first EOD signal arrives. Avoids
        // a perpetual setInterval in tests / wiring that never sees EOD traffic.
    }

    add(signal: TradeSignalDTO): void {
        if (this.stopped) return;

        const declared = (signal.features_snapshot?.report_cadence as Cadence | undefined) ?? 'per_cycle';
        const cadence  = this.effectiveCadence(declared);

        if (cadence === 'eod') {
            this.addEod(signal);
            return;
        }
        this.addWindowed(signal, cadence);
    }

    // ── Windowed cadences (per_cycle / hourly / four_hourly) ──────────────────

    private addWindowed(signal: TradeSignalDTO, cadence: Exclude<Cadence, 'eod'>): void {
        const windowMs    = CADENCE_TO_WINDOW_MS[cadence];
        const bucketIndex = Math.floor(signal.timestamp / windowMs);
        const cycleTs     = bucketIndex * windowMs;
        const bucketEndMs = cycleTs + windowMs;
        const cycleKey    = `${signal.strategy_id}:${cadence}:${bucketIndex}`;
        const t           = this.now();

        const batch = this.upsertBatch({
            cycleKey, cycleTs, cadence, strategyId: signal.strategy_id, now: t,
        });
        this.mergeSignal(batch, signal, t);

        // Reschedule the bucket's timer for max(end-of-window, lastSeenAt + safety-valve).
        // The pattern keeps the flush predictable at the window boundary while extending
        // when late arrivals come in just after the window closed.
        const flushAt = Math.max(bucketEndMs, batch.lastSeenAt + this.trailingDebounceMs);
        this.scheduleFlush(cycleKey, flushAt - t);
    }

    // ── EOD cadence ──────────────────────────────────────────────────────────

    private addEod(signal: TradeSignalDTO): void {
        const market = this.marketOf(signal.ticker);
        const sessionDate = utcDateOf(signal.timestamp);
        const cycleKey = `${signal.strategy_id}:eod:${market}:${sessionDate}`;
        const t = this.now();

        // A signal arriving after the day's EOD flush goes nowhere — accepting it would
        // either trigger a second email for the same day (wrong) or stay forever buffered
        // until midnight rolls over (unbounded memory). Drop with a warn instead.
        if (this.flushedEodKeys.has(cycleKey)) {
            this.opts.logger.warn({ cycleKey, signalId: signal.id },
                'cycle-batcher: EOD bucket already flushed today — dropping late arrival');
            return;
        }

        const batch = this.upsertBatch({
            cycleKey, cycleTs: utcMidnightOf(signal.timestamp), cadence: 'eod',
            strategyId: signal.strategy_id, market, now: t,
        });
        this.mergeSignal(batch, signal, t);
        // EOD flush is timer-driven — lazy-start the ticker on first arrival so a
        // batcher that never sees EOD traffic doesn't burn a setInterval slot.
        this.startEodTickerIfNeeded();
    }

    private async tickEod(): Promise<void> {
        if (this.stopped) return;
        const nowMs = this.now();
        // Snapshot keys so we can mutate the map while iterating.
        for (const [key, batch] of Array.from(this.buckets.entries())) {
            if (batch.cadence !== 'eod') continue;
            const cal = (batch.market && batch.market !== 'OTHER')
                ? this.calendars[batch.market]
                : undefined;
            if (!cal) {
                // No calendar wired for this market — fall back to the trailing-debounce
                // safety valve so signals don't sit forever. Flush once the batch has
                // been idle for the safety-valve window. Stamp the bucket key into
                // flushedEodKeys so a late arrival for the same session date drops
                // instead of re-creating the bucket and firing a second email.
                if (nowMs - batch.lastSeenAt >= this.trailingDebounceMs) {
                    await this.flushBucket(key);
                    this.flushedEodKeys.add(key);
                }
                continue;
            }
            const state = await marketStateOf(cal, nowMs);
            if (state !== 'CLOSED') continue;
            // CLOSED can mean either pre-open (early AM) or post-close (evening). We only
            // want to flush AFTER the session this batch represents has closed — verify
            // by checking that nowMs is past the session close that produced these signals.
            // `nextClose(cal, batch.cycleTs)` gives us today's close for a signal stamped
            // mid-session; if nowMs is past that, we're post-close.
            let sessionClose: number;
            try {
                sessionClose = await nextClose(cal, batch.cycleTs);
            } catch (err) {
                this.opts.logger.warn({ err, market: batch.market }, 'cycle-batcher: nextClose failed — leaving EOD bucket for next tick');
                continue;
            }
            if (nowMs < sessionClose) continue;
            await this.flushBucket(key);
            this.flushedEodKeys.add(key);
        }
    }

    private startEodTickerIfNeeded(): void {
        if (this.eodTicker) return;
        // Cheap unconditional ticker — no-ops when there's no EOD bucket to flush. Avoids
        // an init-order dance where the first EOD signal needs to also boot the ticker.
        this.eodTicker = setInterval(() => {
            this.tickEod().catch((err) => {
                this.opts.logger.error({ err }, 'cycle-batcher: EOD ticker failed');
            });
        }, this.eodTimerIntervalMs);
        // Don't keep the event loop alive just for this ticker.
        if (typeof this.eodTicker.unref === 'function') this.eodTicker.unref();
    }

    // ── Override + cadence resolution ────────────────────────────────────────

    private effectiveCadence(declared: Cadence): Cadence {
        // Per-cycle strategies (daily) ignore the override entirely — flipping a daily
        // strategy to hourly would split rebalance signals across two buckets.
        if (declared === 'per_cycle') return 'per_cycle';
        // Intraday strategies respect the override, but per_cycle is forbidden (would
        // reintroduce the original problem the cadence design fixes). The wiring layer
        // should reject per_cycle overrides at boot; defensive check here too.
        if (!this.intradayOverride) return declared;
        if (this.intradayOverride === 'per_cycle') return declared;
        return this.intradayOverride;
    }

    // ── Shared helpers ───────────────────────────────────────────────────────

    private upsertBatch(args: {
        cycleKey: string; cycleTs: number; cadence: Cadence;
        strategyId: string; market?: EodMarket; now: number;
    }): CycleBatch {
        let batch = this.buckets.get(args.cycleKey);
        if (!batch) {
            batch = {
                cycleKey:    args.cycleKey,
                cycleTs:     args.cycleTs,
                cadence:     args.cadence,
                strategyId:  args.strategyId,
                signals:     [],
                firstSeenAt: args.now,
                lastSeenAt:  args.now,
                ...(args.market !== undefined ? { market: args.market } : {}),
            };
            this.buckets.set(args.cycleKey, batch);
        }
        return batch;
    }

    private mergeSignal(batch: CycleBatch, signal: TradeSignalDTO, now: number): void {
        // Dedup by signal.id — re-fires within the same bucket merge into one entry.
        if (!batch.signals.some((s) => s.id === signal.id)) batch.signals.push(signal);
        batch.lastSeenAt = now;
    }

    private scheduleFlush(cycleKey: string, delayMs: number): void {
        const existing = this.timers.get(cycleKey);
        if (existing) clearTimeout(existing);
        const t = setTimeout(() => {
            this.flushBucket(cycleKey).catch((err) => {
                this.opts.logger.error({ err, cycleKey }, 'cycle-batcher: flush failed');
            });
        }, Math.max(0, delayMs));
        if (typeof t.unref === 'function') t.unref();
        this.timers.set(cycleKey, t);
    }

    private async flushBucket(cycleKey: string): Promise<void> {
        const batch = this.buckets.get(cycleKey);
        if (!batch) return;
        this.buckets.delete(cycleKey);
        const timer = this.timers.get(cycleKey);
        if (timer) { clearTimeout(timer); this.timers.delete(cycleKey); }
        this.opts.logger.info({
            cycleKey,
            cadence:     batch.cadence,
            n:           batch.signals.length,
            tickers:     batch.signals.map((s) => s.ticker).slice(0, 8),
            firstSeenAt: batch.firstSeenAt,
            ageMs:       this.now() - batch.firstSeenAt,
        }, 'cycle-batcher: flushing');
        await this.opts.onFlush(batch);
    }

    private marketOf(ticker: string): EodMarket {
        if (/_US_EQ$/.test(ticker)) return 'US';
        if (/l_EQ$/.test(ticker))   return 'LSE';
        return 'OTHER';
    }

    // Drain remaining batches on shutdown so we don't lose the last cycle's digest.
    async drain(): Promise<void> {
        this.stopped = true;
        if (this.eodTicker) { clearInterval(this.eodTicker); this.eodTicker = undefined; }
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
        const keys = Array.from(this.buckets.keys());
        for (const k of keys) await this.flushBucket(k);
    }
}

// ── Cadence + override resolution helpers ────────────────────────────────────

/**
 * Resolves the operator's intraday override against a declared strategy cadence.
 * - Daily strategies (`per_cycle`) IGNORE the override — flipping a daily strategy
 *   to hourly would split one rebalance into two buckets.
 * - Intraday strategies respect the override; the operator can dial it DOWN
 *   (more rolling — hourly → four_hourly → eod) but cannot dial it back UP to
 *   `per_cycle`, which would reintroduce the 12-emails-per-hour problem.
 *
 * Exported for use in wiring.ts so the env-resolution path stays one-sourced with
 * the batcher's internal logic.
 */
export function resolveEffectiveCadence(declared: Cadence, override: Cadence | undefined): Cadence {
    if (declared === 'per_cycle') return 'per_cycle';
    if (!override)                return declared;
    if (override === 'per_cycle') return declared;   // forbidden override; ignore
    return override;
}

// ── Date helpers ──────────────────────────────────────────────────────────

function utcDateOf(timestampMs: number): string {
    return new Date(timestampMs).toISOString().slice(0, 10);   // YYYY-MM-DD
}

function utcMidnightOf(timestampMs: number): number {
    const d = new Date(timestampMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Re-export the lazy calendar factories from shared-calendar so the wiring layer can
// construct them without learning the package's internal layout.
export { nyseCalendar, lseCalendar, type HolidayCache };
