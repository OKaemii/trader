import type { Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import type { Logger } from '@trader/core';
import type { SignalServiceClient } from '@trader/contracts';
import { type Currency, type Money, SignalFailureReason } from '@trader/shared-types';

import type { Trading212Client } from '../../t212/infrastructure/Trading212Client.ts';
import type { AccountCache } from './AccountCache.ts';
import { MongoOrderRepository } from './MongoOrderRepository.ts';
import { MongoPriceLookup } from '../../../shared/MongoPriceLookup.ts';
import { T212OrderExecutor } from '../../t212/infrastructure/T212OrderExecutor.ts';
import { PlaceOrderUseCase } from '../application/PlaceOrderUseCase.ts';
import { getSignalOrderType } from './live-config.ts';
import { TradingMode, OrderStatus, OrderType, OrderSide } from '../domain/Order.ts';

// OrderDispatcher — the durable-queue worker. Replaces the synchronous "approve →
// trading-service POST /internal/signals/trading/execute → T212" path that previously
// hammered the broker on every signal arrival.
//
// Loop:
//   1. POST /internal/queue/claim to signal-service (atomic FIFO claim, lifecycle
//      queued → executing, attempts++).
//   2. If no signal: sleep idleSleepMs and retry.
//   3. Otherwise: validate (TTL, drift, cash → quantity), place order, transition
//      lifecycle (executed / failed / requeue) based on outcome.
//   4. Sleep minIntervalMs before the next claim regardless, to throttle T212 calls.
//
// Failure handling rules — see CLAUDE.md and the in-repo plan for the rationale:
//   - cash_insufficient (quantity=0):    → failed (terminal)
//   - market_drift (>tolerance):          → failed (terminal)
//   - queue_expired (age > ttl):          → failed (terminal)
//   - T212 429 / transient error:         → requeue, attempts already incremented.
//                                           After ORDER_MAX_ATTEMPTS → failed (retries_exhausted).
//   - T212 4xx non-429 (broker_rejected): → failed (terminal). attempts cap applies.
//
// Idempotency: PlaceOrderUseCase checks MongoOrderRepository.findBySignalId before
// placing, so a duplicate claim (post-crash sweep, etc) won't create a second T212 order.

const LIVE_GATE_KEY = 'trading:live_approved';

export interface ClaimedSignal {
    id:           string;
    ticker:       string;
    action:       'BUY' | 'SELL' | 'HOLD';
    targetWeight: number;
    confidence:   number;
    entryPrice?:  number;
    timestamp:    number;
    attempts:     number;
}

export interface OrderDispatcherDeps {
    tradingMode:      TradingMode;
    client:           Trading212Client;
    accountCache:     AccountCache;
    signal:           SignalServiceClient;
    logger:           Logger;
    getDb:            () => Promise<Db>;
    getRedis:         () => Promise<Pick<RedisClientType, 'get'>>;
    // FX-converter for sizing orders: account NAV lives in GBP (T212 UK base) but every
    // order quantity must be computed in the instrument's listing currency. Required for
    // any USD-listed ticker to be sized correctly. Optional so tests can inject a no-op.
    fxFromGBP?:       (amount: number, target: Currency) => Promise<number>;
    // Knobs — all default-on-undefined so a partial config still boots sensibly.
    minIntervalMs?:       number;
    idleSleepMs?:         number;
    maxAttempts?:         number;
    queueTtlMs?:          number;
    priceDriftTolerance?: number;
    now?:                 () => number;
}

type FailureReason = SignalFailureReason;

export class OrderDispatcher {
    private readonly minIntervalMs: number;
    private readonly idleSleepMs:   number;
    private readonly maxAttempts:   number;
    private readonly queueTtlMs:    number;
    private readonly drift:         number;
    private readonly now:           () => number;
    private stopped = false;

    constructor(private readonly deps: OrderDispatcherDeps) {
        this.minIntervalMs = deps.minIntervalMs       ?? 1100;
        this.idleSleepMs   = deps.idleSleepMs         ?? 5000;
        this.maxAttempts   = deps.maxAttempts         ?? 5;
        this.queueTtlMs    = deps.queueTtlMs          ?? 60 * 60_000;
        this.drift         = deps.priceDriftTolerance ?? 0.01;
        this.now           = deps.now                 ?? (() => Date.now());
    }

    stop(): void { this.stopped = true; }

    async start(): Promise<void> {
        this.deps.logger.info({
            mode: TradingMode[this.deps.tradingMode],
            minIntervalMs: this.minIntervalMs,
            idleSleepMs:   this.idleSleepMs,
            maxAttempts:   this.maxAttempts,
            queueTtlMs:    this.queueTtlMs,
            drift:         this.drift,
        }, 'order-dispatcher: starting loop');
        let idleTicks = 0;
        let cycleCounter = 0;
        while (!this.stopped) {
            try {
                const signal = await this.claim();
                if (!signal) {
                    idleTicks++;
                    if (idleTicks % 12 === 0) {
                        this.deps.logger.info({ idleTicks, idleSleepMs: this.idleSleepMs },
                            'order-dispatcher: idle (queue empty)');
                    }
                    await this.sleep(this.idleSleepMs);
                    continue;
                }
                idleTicks = 0;
                cycleCounter++;
                this.deps.logger.info({
                    cycle: cycleCounter,
                    signalId: signal.id,
                    ticker:   signal.ticker,
                    action:   signal.action,
                    targetWeight: signal.targetWeight,
                    confidence:   signal.confidence,
                    entryPrice:   signal.entryPrice,
                    attempts:     signal.attempts,
                    ageMs:        this.now() - signal.timestamp,
                }, 'order-dispatcher: claimed signal');
                const procStart = Date.now();
                await this.processOne(signal);
                this.deps.logger.info({
                    cycle: cycleCounter, signalId: signal.id, durationMs: Date.now() - procStart,
                }, 'order-dispatcher: processed signal');
            } catch (err) {
                this.deps.logger.error({ err }, 'dispatcher loop error');
                await this.sleep(this.idleSleepMs);
            }
            await this.sleep(this.minIntervalMs);
        }
        this.deps.logger.info('order-dispatcher: loop stopped');
    }

    // Returns nothing; all outcomes are written to signal-service via callbacks.
    private async processOne(signal: ClaimedSignal): Promise<void> {
        if (signal.action === 'HOLD') {
            this.deps.logger.warn({ signalId: signal.id, ticker: signal.ticker },
                'dispatcher: rejecting HOLD action (cannot be placed)');
            await this.markFailed(signal.id, SignalFailureReason.BrokerRejected, 'HOLD action cannot be placed');
            return;
        }

        if (signal.attempts > this.maxAttempts) {
            this.deps.logger.warn({ signalId: signal.id, attempts: signal.attempts, cap: this.maxAttempts },
                'dispatcher: retries exhausted');
            await this.markFailed(signal.id, SignalFailureReason.RetriesExhausted, `exceeded ${this.maxAttempts} attempts`);
            return;
        }

        const ageMs = this.now() - signal.timestamp;
        if (ageMs > this.queueTtlMs) {
            this.deps.logger.warn({ signalId: signal.id, ageMs, ttl: this.queueTtlMs },
                'dispatcher: queue expired');
            await this.markFailed(signal.id, SignalFailureReason.QueueExpired,
                `age=${ageMs}ms > ttl=${this.queueTtlMs}ms`);
            return;
        }

        if (this.deps.tradingMode === TradingMode.Paper) {
            this.deps.logger.info({ signalId: signal.id, ticker: signal.ticker },
                'dispatcher: TRADING_MODE=Paper — marking executed (no broker call)');
            await this.notifyExecuted(signal.id, this.now());
            return;
        }

        let snapshot;
        try {
            snapshot = await this.deps.accountCache.get();
        } catch (err) {
            this.deps.logger.warn({ err, signalId: signal.id }, 'account snapshot failed');
            await this.transientFailureOrRequeue(signal, SignalFailureReason.BrokerRejected, `account fetch: ${this.errStr(err)}`);
            return;
        }

        this.deps.logger.info({
            signalId: signal.id,
            ticker:   signal.ticker,
            cashFree: snapshot.free?.amount,
            cashTotal: snapshot.total?.amount,
            cashCcy:  snapshot.total?.currency,
            positions: snapshot.positions.length,
        }, 'dispatcher: account snapshot ok');

        const db = await this.deps.getDb();
        const priceLookup = new MongoPriceLookup(db);
        const currentPrice = await priceLookup.lastCloseMoney(signal.ticker);

        if (!currentPrice) {
            this.deps.logger.warn({ signalId: signal.id, ticker: signal.ticker },
                'dispatcher: no current price in Mongo — sizing will return 0 and signal will fail CashInsufficient');
        } else {
            this.deps.logger.info({
                signalId: signal.id, ticker: signal.ticker,
                currentPrice: currentPrice.amount, currency: currentPrice.currency,
            }, 'dispatcher: current price loaded');
        }

        // Drift gate: scalar comparison in the instrument's currency. Both currentPrice.amount
        // and signal.entryPrice are recorded at emission in the instrument currency, so the
        // comparison stays valid without any FX hop.
        if (signal.entryPrice && currentPrice && signal.entryPrice > 0) {
            const movement = Math.abs(currentPrice.amount - signal.entryPrice) / signal.entryPrice;
            if (movement > this.drift) {
                this.deps.logger.warn({
                    signalId: signal.id, ticker: signal.ticker,
                    entry: signal.entryPrice, current: currentPrice.amount,
                    movement, tolerance: this.drift,
                }, 'dispatcher: price drift exceeds tolerance — failing signal');
                await this.markFailed(
                    signal.id,
                    SignalFailureReason.MarketDrift,
                    `entry=${signal.entryPrice.toFixed(4)} current=${currentPrice.amount.toFixed(4)} delta=${(movement * 100).toFixed(2)}%`,
                );
                return;
            }
            this.deps.logger.info({
                signalId: signal.id, movement, tolerance: this.drift,
            }, 'dispatcher: drift within tolerance');
        }

        const currentQuantity = snapshot.positions.find((p) => p.ticker === signal.ticker)?.quantity ?? 0;

        const redis = await this.deps.getRedis();
        const orderRepo = new MongoOrderRepository(db);

        // In-flight awareness: T212 fills are async. Without this, two BUY signals for the
        // same ticker fired back-to-back both see currentQuantity=0 and both place the full
        // delta, doubling the position. Net the submitted-but-unfilled orders into an
        // effective position before sizing. BUYs add, SELLs subtract.
        const inflightT0 = Date.now();
        const inflight = await orderRepo.findInflightByTicker(signal.ticker);
        const inflightMs = Date.now() - inflightT0;
        if (inflightMs > 500) {
            this.deps.logger.warn({ signalId: signal.id, ticker: signal.ticker, inflightMs },
                'dispatcher: findInflightByTicker slow (>500ms)');
        }
        const inflightDelta = inflight.reduce(
            (acc, o) => acc + (o.side === OrderSide.Buy ? o.quantity : -o.quantity),
            0,
        );
        const effectiveQuantity = currentQuantity + inflightDelta;
        if (inflightDelta !== 0) {
            this.deps.logger.info({
                signalId: signal.id, ticker: signal.ticker,
                currentQuantity, inflightDelta, effectiveQuantity,
                inflightCount: inflight.length,
            }, 'dispatcher: inflight orders detected — sizing against effective position');
        }

        const existingT0 = Date.now();
        const existing  = await orderRepo.findBySignalId(signal.id);
        const existingMs = Date.now() - existingT0;
        if (existingMs > 500) {
            this.deps.logger.warn({ signalId: signal.id, ticker: signal.ticker, existingMs },
                'dispatcher: findBySignalId slow (>500ms)');
        }
        if (existing) {
            this.deps.logger.info({ signalId: signal.id, orderId: existing.id },
                'order already exists for signal — marking executed (post-crash sweep)');
            await this.notifyExecuted(signal.id, existing.executedAt ?? this.now());
            return;
        }

        const executor = new T212OrderExecutor(this.deps.client);
        const liveApproved = async (): Promise<boolean> => !!(await redis.get(LIVE_GATE_KEY));
        const useCase = new PlaceOrderUseCase({
            orderRepo,
            executor,
            liveApproved,
            signal: this.deps.signal,
            logger: this.deps.logger,
            tradingMode: this.deps.tradingMode,
            getSignalOrderType: async (): Promise<OrderType> => getSignalOrderType(),
        });

        const instrumentCcy: Currency = currentPrice?.currency ?? 'GBP';
        const navGBP                  = snapshot.total.amount;
        const navInstrAmt             = this.deps.fxFromGBP
            ? await this.deps.fxFromGBP(navGBP, instrumentCcy)
            : navGBP;
        const totalNAV: Money = { amount: navInstrAmt, currency: instrumentCcy };
        this.deps.logger.info({
            signalId: signal.id, ticker: signal.ticker,
            navGBP, navInstr: navInstrAmt, instrumentCcy,
            currentQuantity, inflightDelta, effectiveQuantity,
            targetWeight: signal.targetWeight,
        }, 'dispatcher: sized inputs — handing off to PlaceOrderUseCase');

        try {
            const order = await useCase.execute({
                signalId:        signal.id,
                ticker:          signal.ticker,
                action:          signal.action,
                targetWeight:    signal.targetWeight,
                confidence:      signal.confidence,
                totalNAV,
                ...(currentPrice ? { currentPrice } : {}),
                currentQuantity: effectiveQuantity,
            });

            if (!order) {
                // ZeroQuantity is the honest tag: the math returned qty < minQty (0.0001
                // shares), or — for Live mode — the live-trading gate was closed. Cash
                // wasn't the bottleneck; the position size just rounded to nothing.
                // CashInsufficient is reserved for actual cash failures (e.g. when we
                // size correctly but the broker reports insufficient buying power).
                this.deps.logger.warn({ signalId: signal.id, ticker: signal.ticker },
                    'dispatcher: PlaceOrderUseCase returned null — failing as ZeroQuantity');
                await this.markFailed(signal.id, SignalFailureReason.ZeroQuantity,
                    'PlaceOrderUseCase returned null (qty < minQty or live gate closed)');
                return;
            }

            if (order.status === OrderStatus.Failed) {
                this.deps.logger.warn({ signalId: signal.id, ticker: signal.ticker, error: order.errorMessage },
                    'dispatcher: order placement failed at broker');
                await this.transientFailureOrRequeue(signal, SignalFailureReason.BrokerRejected,
                    order.errorMessage ?? 'unknown broker error');
                return;
            }

            this.deps.logger.info({
                signalId: signal.id, ticker: signal.ticker,
                orderId: order.id, t212OrderId: order.t212OrderId,
                status: OrderStatus[order.status], qty: order.quantity, limitPrice: order.limitPrice,
            }, 'dispatcher: order placed');
            this.deps.accountCache.invalidate();
        } catch (err) {
            this.deps.logger.warn({ err, signalId: signal.id }, 'place-order threw');
            await this.transientFailureOrRequeue(signal, SignalFailureReason.BrokerRejected, this.errStr(err));
        }
    }

    private async transientFailureOrRequeue(signal: ClaimedSignal, terminalReason: FailureReason, detail: string): Promise<void> {
        const transient = detail.includes('429') || /timeout|ECONN|fetch failed/i.test(detail);
        if (transient && signal.attempts < this.maxAttempts) {
            await this.requeue(signal.id);
            return;
        }
        const reason: FailureReason = transient ? SignalFailureReason.RetriesExhausted : terminalReason;
        await this.markFailed(signal.id, reason, detail);
    }

    // ── signal-service callbacks via typed contract client ──────────────────────

    private async claim(): Promise<ClaimedSignal | null> {
        try {
            const res = await this.deps.signal.claimQueue();
            return res.signal as ClaimedSignal | null;
        } catch (err) {
            this.deps.logger.warn({ err }, 'claim failed');
            return null;
        }
    }

    private async requeue(id: string): Promise<void> {
        try {
            await this.deps.signal.requeue(id);
        } catch (err) {
            this.deps.logger.warn({ err, signalId: id }, 'requeue failed');
        }
    }

    private async markFailed(id: string, reason: FailureReason, detail: string): Promise<void> {
        const t0 = Date.now();
        try {
            await this.deps.signal.failQueue(id, reason, detail);
            const ms = Date.now() - t0;
            if (ms > 1000) this.deps.logger.warn({ signalId: id, reason, ms }, 'mark-failed slow (>1s)');
        } catch (err) {
            this.deps.logger.warn({ err, signalId: id, reason, detail, ms: Date.now() - t0 }, 'mark-failed failed');
        }
    }

    private async notifyExecuted(id: string, at: number): Promise<void> {
        const t0 = Date.now();
        try {
            await this.deps.signal.markExecuted(id, at);
            const ms = Date.now() - t0;
            if (ms > 1000) this.deps.logger.warn({ signalId: id, ms }, 'notify-executed slow (>1s)');
        } catch (err) {
            this.deps.logger.warn({ err, signalId: id, ms: Date.now() - t0 }, 'notify-executed failed');
        }
    }

    async sweepStaleExecuting(thresholdMs = 60_000): Promise<number> {
        try {
            const res = await this.deps.signal.sweepQueue(thresholdMs);
            return res.reverted;
        } catch (err) {
            this.deps.logger.warn({ err }, 'sweep failed');
            return 0;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((r) => setTimeout(r, ms));
    }

    private errStr(err: unknown): string {
        return err instanceof Error ? err.message : String(err);
    }
}
