import { generateInternalToken } from '@trader/shared-auth';
import type { Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import type { Trading212Client } from './t212.ts';
import type { AccountCache } from './account-cache.ts';
import { MongoOrderRepository } from './MongoOrderRepository.ts';
import { MongoPriceLookup } from './MongoPriceLookup.ts';
import { T212OrderExecutor } from './T212OrderExecutor.ts';
import { PlaceOrderUseCase } from '../application/use-cases/PlaceOrderUseCase.ts';
import { getSignalOrderType } from './live-config.ts';
import { TradingMode, OrderStatus } from '../domain/entities/Order.ts';
import { type Currency, type Money, SignalFailureReason } from '@trader/shared-types';

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
  signalServiceUrl: string;
  tradingMode:      TradingMode;
  client:           Trading212Client;
  accountCache:     AccountCache;
  getDb:            () => Promise<Db>;
  getRedis:         () => Promise<Pick<RedisClientType, 'get'>>;
  // FX-converter for sizing orders: account NAV lives in GBP (T212 UK base) but every
  // order quantity must be computed in the instrument's listing currency. Required for
  // any USD-listed ticker to be sized correctly. Optional so tests can inject a no-op
  // (e.g. identity for GBP-only fixtures).
  fxFromGBP?:       (amount: number, target: Currency) => Promise<number>;
  // Knobs — all default-on-undefined so a partial config still boots sensibly.
  minIntervalMs?:       number;  // sleep between claims (rate limit floor)
  idleSleepMs?:         number;  // sleep when queue empty
  maxAttempts?:         number;  // attempts cap → retries_exhausted
  queueTtlMs?:          number;  // signal age cap → queue_expired
  priceDriftTolerance?: number;  // [0,1] fraction; >this → market_drift
  now?:                 () => number;
}

// Local alias for readability — the dispatcher only mints reasons via the enum, never raw integers.
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
    this.queueTtlMs    = deps.queueTtlMs          ?? 60 * 60_000;  // 1h daily default
    this.drift         = deps.priceDriftTolerance ?? 0.01;          // 1%
    this.now           = deps.now                 ?? (() => Date.now());
  }

  stop(): void { this.stopped = true; }

  async start(): Promise<void> {
    console.log(`[order-dispatcher] starting (mode=${this.deps.tradingMode}, minInterval=${this.minIntervalMs}ms, maxAttempts=${this.maxAttempts}, ttl=${this.queueTtlMs}ms, drift=${this.drift})`);
    while (!this.stopped) {
      try {
        const signal = await this.claim();
        if (!signal) {
          await this.sleep(this.idleSleepMs);
          continue;
        }
        await this.processOne(signal);
      } catch (err) {
        console.error('[order-dispatcher] loop error:', err);
        await this.sleep(this.idleSleepMs);
      }
      await this.sleep(this.minIntervalMs);
    }
  }

  // ---- single-signal processing ----
  // Returns nothing; all outcomes are written to signal-service via callbacks.
  private async processOne(signal: ClaimedSignal): Promise<void> {
    // Skip HOLD (defensive — ApproveSignal already filters it).
    if (signal.action === 'HOLD') {
      await this.markFailed(signal.id, SignalFailureReason.BrokerRejected, 'HOLD action cannot be placed');
      return;
    }

    // Attempts cap. The claim already incremented attempts to N; if N > max, give up.
    if (signal.attempts > this.maxAttempts) {
      await this.markFailed(signal.id, SignalFailureReason.RetriesExhausted, `exceeded ${this.maxAttempts} attempts`);
      return;
    }

    // Queue TTL: if the signal sat in the queue past its freshness window, abandon it.
    if (this.now() - signal.timestamp > this.queueTtlMs) {
      await this.markFailed(signal.id, SignalFailureReason.QueueExpired, `age=${this.now() - signal.timestamp}ms > ttl=${this.queueTtlMs}ms`);
      return;
    }

    if (this.deps.tradingMode === TradingMode.Paper) {
      // In paper mode the dispatcher still drains the queue, but never calls T212.
      // Mark signals as executed at the queue stage so notifications still fire and
      // the portal reflects "would have placed."
      await this.notifyExecuted(signal.id, this.now());
      return;
    }

    // Account snapshot (cached). If T212 is hard-down with no stale fallback, requeue.
    let snapshot;
    try {
      snapshot = await this.deps.accountCache.get();
    } catch (err) {
      console.warn(`[order-dispatcher] account snapshot failed for ${signal.id}:`, err);
      await this.transientFailureOrRequeue(signal, SignalFailureReason.BrokerRejected, `account fetch: ${this.errStr(err)}`);
      return;
    }

    // Current price for drift gate + quantity sizing. Money-typed: carries the
    // instrument's listing currency from the bar, which becomes the single source of
    // truth for `instrumentCcy` below (was previously derived from ticker suffix —
    // two sources, easy to drift).
    const db = await this.deps.getDb();
    const priceLookup = new MongoPriceLookup(db);
    const currentPrice = await priceLookup.lastCloseMoney(signal.ticker);

    // Drift gate: scalar comparison in the instrument's currency. Both currentPrice.amount
    // and signal.entryPrice are recorded at emission in the instrument currency, so the
    // comparison stays valid without any FX hop.
    if (signal.entryPrice && currentPrice && signal.entryPrice > 0) {
      const movement = Math.abs(currentPrice.amount - signal.entryPrice) / signal.entryPrice;
      if (movement > this.drift) {
        await this.markFailed(
          signal.id,
          SignalFailureReason.MarketDrift,
          `entry=${signal.entryPrice.toFixed(4)} current=${currentPrice.amount.toFixed(4)} delta=${(movement * 100).toFixed(2)}%`,
        );
        return;
      }
    }

    const currentQuantity = snapshot.positions.find((p) => p.ticker === signal.ticker)?.quantity ?? 0;

    // Hand off to PlaceOrderUseCase with snapshot-derived sizing inputs.
    const redis = await this.deps.getRedis();
    const orderRepo = new MongoOrderRepository(db);
    const existing  = await orderRepo.findBySignalId(signal.id);
    if (existing) {
      // Idempotency: an order already exists for this signal. Treat as success — most
      // likely we crashed between T212 ack and lifecycle write, and the sweep requeued us.
      console.log(`[order-dispatcher] order already exists for signal ${signal.id} (id=${existing.id}) — marking executed`);
      await this.notifyExecuted(signal.id, existing.executedAt ?? this.now());
      return;
    }

    const executor = new T212OrderExecutor(this.deps.client);
    const liveApproved = async () => !!(await redis.get(LIVE_GATE_KEY));
    const useCase = new PlaceOrderUseCase(orderRepo, executor, liveApproved, getSignalOrderType);

    // FX-convert account NAV from GBP (T212 base) into the instrument's listing
    // currency so PlaceOrderUseCase can compute share count without unit confusion.
    // Single source of truth for the instrument currency: the price lookup itself.
    // If currentPrice is null we can't size — _computeQuantity returns 0, dispatcher
    // marks the signal failed below. Sentinel GBP totalNAV is safe because the use
    // case rejects zero-price inputs before touching currency arithmetic.
    const instrumentCcy: Currency = currentPrice?.currency ?? 'GBP';
    const navGBP                  = snapshot.total.amount;
    const navInstrAmt             = this.deps.fxFromGBP
      ? await this.deps.fxFromGBP(navGBP, instrumentCcy)
      : navGBP;
    const totalNAV: Money = { amount: navInstrAmt, currency: instrumentCcy };

    try {
      const order = await useCase.execute({
        signalId:        signal.id,
        ticker:          signal.ticker,
        action:          signal.action,
        targetWeight:    signal.targetWeight,
        confidence:      signal.confidence,
        totalNAV,
        currentPrice:    currentPrice ?? undefined,
        currentQuantity,
      });

      if (!order) {
        // PlaceOrderUseCase returns null for: paper mode (handled above), live gate
        // closed, negative weight, or quantity=0. In all cases, the conditions changed
        // since emission — cash_insufficient is the catch-all reason for the portal.
        await this.markFailed(signal.id, SignalFailureReason.CashInsufficient, 'PlaceOrderUseCase returned null (zero qty or gate closed)');
        return;
      }

      if (order.status === OrderStatus.Failed) {
        // Inner T212 call threw. Decide retry vs terminal based on error shape.
        await this.transientFailureOrRequeue(signal, SignalFailureReason.BrokerRejected, order.errorMessage ?? 'unknown broker error');
        return;
      }

      // Success — submitted or filled. PlaceOrderUseCase already called notifySignalExecuted.
      // No further state mutation needed here. Invalidate cache so the next claim re-reads.
      this.deps.accountCache.invalidate();
    } catch (err) {
      console.warn(`[order-dispatcher] place-order threw for ${signal.id}:`, err);
      await this.transientFailureOrRequeue(signal, SignalFailureReason.BrokerRejected, this.errStr(err));
    }
  }

  // 429 / transient: requeue if attempts left, otherwise fail with retries_exhausted.
  private async transientFailureOrRequeue(signal: ClaimedSignal, terminalReason: FailureReason, detail: string): Promise<void> {
    const transient = detail.includes('429') || /timeout|ECONN|fetch failed/i.test(detail);
    if (transient && signal.attempts < this.maxAttempts) {
      await this.requeue(signal.id);
      return;
    }
    const reason: FailureReason = transient ? SignalFailureReason.RetriesExhausted : terminalReason;
    await this.markFailed(signal.id, reason, detail);
  }

  // ---- signal-service HTTP callbacks ----

  private async claim(): Promise<ClaimedSignal | null> {
    const res = await this.signalFetch('/internal/queue/claim', { method: 'POST' });
    if (!res.ok) {
      console.warn(`[order-dispatcher] claim ${res.status}: ${await res.text()}`);
      return null;
    }
    const body = await res.json() as { signal: ClaimedSignal | null };
    return body.signal ?? null;
  }

  private async requeue(id: string): Promise<void> {
    await this.signalFetch(`/internal/queue/${encodeURIComponent(id)}/requeue`, { method: 'POST' });
  }

  private async markFailed(id: string, reason: FailureReason, detail: string): Promise<void> {
    await this.signalFetch(`/internal/queue/${encodeURIComponent(id)}/failed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, detail }),
    });
  }

  private async notifyExecuted(id: string, at: number): Promise<void> {
    await this.signalFetch(`/internal/trading/signals/${encodeURIComponent(id)}/executed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at }),
    });
  }

  async sweepStaleExecuting(thresholdMs: number = 60_000): Promise<number> {
    const res = await this.signalFetch('/internal/queue/sweep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thresholdMs }),
    });
    if (!res.ok) return 0;
    const body = await res.json() as { reverted?: number };
    return body.reverted ?? 0;
  }

  // ---- helpers ----

  private async signalFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('X-Internal-Token', generateInternalToken('trading-service'));
    return fetch(`${this.deps.signalServiceUrl}${path}`, { ...init, headers });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private errStr(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
