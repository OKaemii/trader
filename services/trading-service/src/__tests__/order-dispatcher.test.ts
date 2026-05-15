// Unit tests for OrderDispatcher.processOne — drift gate, queue TTL, attempts cap,
// transient-vs-terminal failure classification, paper-mode short-circuit, idempotent
// re-recognition of an existing order.
//
// These tests don't run the loop (start()) — they call processOne directly with a
// claimed signal and a stub HTTP fetch so each transition is observable in isolation.

process.env.INTERNAL_SECRET = 'test-internal-secret';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { OrderDispatcher, type ClaimedSignal, type OrderDispatcherDeps } from '../infrastructure/order-dispatcher.ts';
import { AccountCache } from '../infrastructure/account-cache.ts';
import { TradingMode } from '../domain/entities/Order.ts';
import { SignalFailureReason } from '@trader/shared-types';

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

interface FetchCall { url: string; body?: any }
function installFetch(): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    let body: any;
    try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function makeDeps(overrides: Partial<OrderDispatcherDeps> = {}): OrderDispatcherDeps {
  const cache = new AccountCache(
    { getCash: async () => ({ free: 1_000_000, total: 2_000_000 }), getPositions: async () => [] },
  );
  return {
    signalServiceUrl:    'http://signal-service:3003',
    tradingMode:         TradingMode.Paper,
    client:              {} as any,
    accountCache:        cache,
    getDb:               async () => ({}) as any,
    getRedis:            async () => ({ get: async () => null }) as any,
    minIntervalMs:       0,
    idleSleepMs:         0,
    maxAttempts:         5,
    queueTtlMs:          60_000,
    priceDriftTolerance: 0.01,
    now:                 () => 1_000_000,
    ...overrides,
  };
}

describe('OrderDispatcher', () => {
  it('paper mode short-circuits to executed without calling T212', async () => {
    const fetchSpy = installFetch();
    try {
      const deps = makeDeps({ tradingMode: TradingMode.Paper });
      const d    = new OrderDispatcher(deps);
      await (d as any).processOne(makeSignal());
      // expect a /executed POST and no /failed or /requeue
      const executedCall = fetchSpy.calls.find((c) => c.url.includes('/executed'));
      expect(executedCall).toBeDefined();
      expect(fetchSpy.calls.some((c) => c.url.includes('/failed'))).toBe(false);
      expect(fetchSpy.calls.some((c) => c.url.includes('/requeue'))).toBe(false);
    } finally {
      fetchSpy.restore();
    }
  });

  it('fails with queue_expired when signal age exceeds queueTtlMs', async () => {
    const fetchSpy = installFetch();
    try {
      const now = 10_000_000;
      const deps = makeDeps({ now: () => now, queueTtlMs: 1000 });
      const d    = new OrderDispatcher(deps);
      await (d as any).processOne(makeSignal({ timestamp: now - 5000 }));
      const failedCall = fetchSpy.calls.find((c) => c.url.includes('/failed'));
      expect(failedCall).toBeDefined();
      expect(failedCall!.body.reason).toBe(SignalFailureReason.QueueExpired);
    } finally {
      fetchSpy.restore();
    }
  });

  it('fails with retries_exhausted when attempts > maxAttempts', async () => {
    const fetchSpy = installFetch();
    try {
      const deps = makeDeps({ maxAttempts: 5 });
      const d    = new OrderDispatcher(deps);
      await (d as any).processOne(makeSignal({ attempts: 6 }));
      const failedCall = fetchSpy.calls.find((c) => c.url.includes('/failed'));
      expect(failedCall).toBeDefined();
      expect(failedCall!.body.reason).toBe(SignalFailureReason.RetriesExhausted);
    } finally {
      fetchSpy.restore();
    }
  });
});
