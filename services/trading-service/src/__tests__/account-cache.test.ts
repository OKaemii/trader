// Tests for AccountCache TTL, in-flight coalescing, and stale-fallback on 429.
//
// The cache exists to keep the order-dispatcher off T212's rate limits — concurrent
// claims should coalesce on a single fetch, and a transient broker error should not
// drop the dispatcher to its knees if a recent snapshot exists.

import { describe, it, expect } from 'bun:test';
import { AccountCache } from '../infrastructure/account-cache.ts';

class FakeClient {
  cashCalls = 0;
  posCalls  = 0;
  free  = 1000;
  total = 2000;
  positions: Array<{
    ticker: string;
    quantity: number;
    averagePrice: { amount: number; currency: 'GBP' };
    currentPrice: { amount: number; currency: 'GBP' };
    currentValue: { amount: number; currency: 'GBP' };
  }> = [{
    ticker: 'AAPL_US_EQ',
    quantity: 5,
    averagePrice: { amount: 100, currency: 'GBP' },
    currentPrice: { amount: 110, currency: 'GBP' },
    currentValue: { amount: 550, currency: 'GBP' },
  }];
  failNext = 0;          // throw on the next N getCash calls
  delayMs  = 0;
  // T212 UK accounts return cash in GBP. We carry the currency tag explicitly here so
  // AccountCache stores it on the snapshot for downstream consumers.
  async getCash() {
    this.cashCalls++;
    if (this.failNext > 0) { this.failNext--; throw new Error('T212 cash: 429'); }
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return {
      free:  { amount: this.free,  currency: 'GBP' as const },
      total: { amount: this.total, currency: 'GBP' as const },
    };
  }
  async getPositions() {
    this.posCalls++;
    return this.positions;
  }
}

describe('AccountCache', () => {
  it('serves from cache within TTL — single T212 fetch', async () => {
    const client = new FakeClient();
    const cache  = new AccountCache(client, { ttlMs: 1000 });
    const a = await cache.get();
    const b = await cache.get();
    expect(a.free.amount).toBe(1000);
    expect(b.free.amount).toBe(1000);
    expect(client.cashCalls).toBe(1);
    expect(client.posCalls).toBe(1);
  });

  it('refetches after TTL expiry', async () => {
    let t = 0;
    const client = new FakeClient();
    const cache  = new AccountCache(client, { ttlMs: 100, now: () => t });
    await cache.get();
    t += 200;
    client.free = 1500;
    const b = await cache.get();
    expect(b.free.amount).toBe(1500);
    expect(client.cashCalls).toBe(2);
  });

  it('coalesces concurrent callers onto one in-flight promise', async () => {
    const client = new FakeClient();
    client.delayMs = 30;
    const cache  = new AccountCache(client, { ttlMs: 1000 });
    const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(a.free.amount).toBe(1000);
    expect(b.free.amount).toBe(1000);
    expect(c.free.amount).toBe(1000);
    // Coalesced: only one underlying T212 fetch despite three concurrent callers
    expect(client.cashCalls).toBe(1);
  });

  it('serves stale snapshot on 429 if within staleFallbackMs', async () => {
    let t = 0;
    const client = new FakeClient();
    const cache  = new AccountCache(client, { ttlMs: 100, staleFallbackMs: 60_000, now: () => t });
    await cache.get();                  // primes the snapshot
    t += 200;                           // TTL expires
    client.failNext = 1;                // next fetch throws 429
    const b = await cache.get();        // should serve the stale snapshot, not throw
    expect(b.free.amount).toBe(1000);
  });

  it('propagates error when no stale fallback available', async () => {
    const client = new FakeClient();
    client.failNext = 1;
    const cache  = new AccountCache(client, { ttlMs: 100, staleFallbackMs: 60_000 });
    await expect(cache.get()).rejects.toThrow(/429/);
  });

  it('invalidate() forces refetch on next get()', async () => {
    const client = new FakeClient();
    const cache  = new AccountCache(client, { ttlMs: 60_000 });
    await cache.get();
    cache.invalidate();
    await cache.get();
    expect(client.cashCalls).toBe(2);
  });
});
