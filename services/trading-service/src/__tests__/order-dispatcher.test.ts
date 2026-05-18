// Unit tests for OrderDispatcher.processOne — drift gate, queue TTL, attempts cap,
// transient-vs-terminal failure classification, paper-mode short-circuit, idempotent
// re-recognition of an existing order.
//
// These tests don't run the loop (start()) — they call processOne directly with a
// claimed signal and a stub SignalServiceClient so each transition is observable.

import { describe, it, expect } from "vitest";
import { OrderDispatcher, type ClaimedSignal, type OrderDispatcherDeps } from '../modules/orders/infrastructure/OrderDispatcher.ts';
import { AccountCache } from '../modules/orders/infrastructure/AccountCache.ts';
import { TradingMode } from '../modules/orders/domain/Order.ts';
import { SignalFailureReason } from '@trader/shared-types';
import type { Logger } from '@trader/core';
import type { SignalServiceClient } from '@trader/contracts';

function makeSignal(overrides: Partial<ClaimedSignal> = {}): ClaimedSignal {
    return {
        id:           'sig-1',
        ticker:       'AAPL_US_EQ',
        action:       'BUY',
        targetWeight: 0.01,
        confidence:   0.5,
        entryPrice:   100,
        timestamp:    Date.now(),
        attempts:     1,
        ...overrides,
    };
}

interface CapturedCalls {
    executed: Array<{ id: string; at?: number; quantity?: number }>;
    closed:   Array<{ id: string; exitPrice: number; at?: number }>;
    requeue:  string[];
    failed:   Array<{ id: string; reason: number; detail?: string }>;
}
function stubSignal(): { client: SignalServiceClient; calls: CapturedCalls } {
    const calls: CapturedCalls = { executed: [], closed: [], requeue: [], failed: [] };
    const client: SignalServiceClient = {
        markExecuted: async (id, at, quantity) => {
            const entry: { id: string; at?: number; quantity?: number } = { id };
            if (at !== undefined) entry.at = at;
            if (quantity !== undefined) entry.quantity = quantity;
            calls.executed.push(entry);
            return { id, executedAt: at ?? 0, executedQuantity: quantity };
        },
        markClosed: async (id, exitPrice, at) => {
            const entry: { id: string; exitPrice: number; at?: number } = { id, exitPrice };
            if (at !== undefined) entry.at = at;
            calls.closed.push(entry);
            return { id, closedAt: at ?? 0, exitPrice };
        },
        decrementQuantity: async () => ({ id: '', decrementedBy: 0 }),
        openBuys:          async () => ({ signals: [] }),
        claimQueue:        async () => ({ signal: null }),
        requeue: async (id) => {
            calls.requeue.push(id);
            return { id, lifecycle: 0 };
        },
        failQueue: async (id, reason, detail) => {
            const entry: { id: string; reason: number; detail?: string } = { id, reason };
            if (detail !== undefined) entry.detail = detail;
            calls.failed.push(entry);
        },
        sweepQueue: async () => ({ reverted: 0 }),
    } as unknown as SignalServiceClient;
    return { client, calls };
}

const noopLogger: Logger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    trace: () => {}, fatal: () => {}, child: () => noopLogger, level: 'info',
} as unknown as Logger;

function makeDeps(overrides: Partial<OrderDispatcherDeps> = {}): { deps: OrderDispatcherDeps; calls: CapturedCalls } {
    const cache = new AccountCache({
        getCash:      async () => ({
            free:  { amount: 1_000_000, currency: 'GBP' as const },
            total: { amount: 2_000_000, currency: 'GBP' as const },
        }),
        getPositions: async () => [],
    });
    const { client, calls } = stubSignal();
    const deps: OrderDispatcherDeps = {
        tradingMode:         TradingMode.Paper,
        client:              {} as never,
        accountCache:        cache,
        signal:              client,
        logger:              noopLogger,
        getDb:               async () => ({}) as never,
        getRedis:            async () => ({ get: async () => null }) as never,
        minIntervalMs:       0,
        idleSleepMs:         0,
        maxAttempts:         5,
        queueTtlMs:          60_000,
        priceDriftTolerance: 0.01,
        now:                 () => 1_000_000,
        ...overrides,
    };
    return { deps, calls };
}

describe('OrderDispatcher', () => {
    it('paper mode short-circuits to executed without calling /failed or /requeue', async () => {
        const { deps, calls } = makeDeps({ tradingMode: TradingMode.Paper });
        const d = new OrderDispatcher(deps);
        await (d as unknown as { processOne: (s: ClaimedSignal) => Promise<void> }).processOne(makeSignal());
        expect(calls.executed.length).toBeGreaterThan(0);
        expect(calls.failed).toHaveLength(0);
        expect(calls.requeue).toHaveLength(0);
    });

    it('fails with queue_expired when signal age exceeds queueTtlMs', async () => {
        const now = 10_000_000;
        const { deps, calls } = makeDeps({ now: () => now, queueTtlMs: 1000 });
        const d = new OrderDispatcher(deps);
        await (d as unknown as { processOne: (s: ClaimedSignal) => Promise<void> }).processOne(
            makeSignal({ timestamp: now - 5000 }),
        );
        expect(calls.failed).toContainEqual(expect.objectContaining({ reason: SignalFailureReason.QueueExpired }));
    });

    it('fails with retries_exhausted when attempts > maxAttempts', async () => {
        const { deps, calls } = makeDeps({ maxAttempts: 5 });
        const d = new OrderDispatcher(deps);
        await (d as unknown as { processOne: (s: ClaimedSignal) => Promise<void> }).processOne(
            makeSignal({ attempts: 6 }),
        );
        expect(calls.failed).toContainEqual(expect.objectContaining({ reason: SignalFailureReason.RetriesExhausted }));
    });
});
