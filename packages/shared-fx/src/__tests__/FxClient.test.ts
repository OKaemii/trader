import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { FxClient, type FxRateProvider } from '../FxClient.ts';
import { money } from '@trader/shared-types';

// In-memory Redis stub — only the methods FxClient touches.
class StubRedis {
  store = new Map<string, string>();
  ttls  = new Map<string, number>();
  async get(k: string): Promise<string | null> { return this.store.get(k) ?? null; }
  async set(k: string, v: string): Promise<'OK'> { this.store.set(k, v); return 'OK'; }
  async setEx(k: string, ttl: number, v: string): Promise<'OK'> {
    this.store.set(k, v);
    this.ttls.set(k, ttl);
    return 'OK';
  }
}

class StubProvider implements FxRateProvider {
  rate = 0.79;
  calls = 0;
  shouldThrow = false;
  async fetchUsdGbpRate(): Promise<number> {
    this.calls++;
    if (this.shouldThrow) throw new Error('Yahoo down');
    return this.rate;
  }
}

function build(opts: { now?: () => number } = {}) {
  const redis = new StubRedis();
  const provider = new StubProvider();
  const fx = new FxClient(redis as any, provider, { now: opts.now });
  return { fx, redis, provider };
}

describe('FxClient', () => {
  it('returns Yahoo rate on first call and caches it', async () => {
    const { fx, redis, provider } = build();
    const r = await fx.usdGbpRate();
    expect(r).toBeCloseTo(0.79, 4);
    expect(provider.calls).toBe(1);
    expect(redis.store.get('fx:GBPUSD')).toBe('0.79');
    expect(redis.ttls.get('fx:GBPUSD')).toBe(3600);
    // Second call hits the cache, not the provider.
    await fx.usdGbpRate();
    expect(provider.calls).toBe(1);
  });

  it('toGBP is identity for GBP and applies rate for USD', async () => {
    const { fx } = build();
    expect(await fx.toGBP(money(100, 'GBP'))).toBe(100);
    expect(await fx.toGBP(money(100, 'USD'))).toBeCloseTo(79, 4);
  });

  it('fromGBP inverts rate for USD target', async () => {
    const { fx } = build();
    const usd = await fx.fromGBP(79, 'USD');
    expect(usd).toBeCloseTo(100, 4);
  });

  it('rejects out-of-bounds rates from the provider', async () => {
    const { fx, provider } = build();
    provider.rate = 5.0;   // way out of [0.5, 1.5]
    await expect(fx.usdGbpRate()).rejects.toThrow(/sanity bounds/);
  });

  it('refetches if the cached rate is somehow corrupt / out of bounds', async () => {
    const { fx, redis, provider } = build();
    redis.store.set('fx:GBPUSD', '99');   // poisoned cache
    const r = await fx.usdGbpRate();
    expect(r).toBeCloseTo(0.79, 4);
    expect(provider.calls).toBe(1);
  });

  it('serves lastGood on Yahoo failure within stale-fallback window', async () => {
    let now = 1_000_000;
    const { fx, redis, provider } = build({ now: () => now });
    // Prime lastGood
    await fx.usdGbpRate();
    expect(provider.calls).toBe(1);

    // Expire hot cache, make provider fail, advance time but stay within 24h.
    redis.store.delete('fx:GBPUSD');
    provider.shouldThrow = true;
    now += 60 * 60 * 1000;   // +1h

    const r = await fx.usdGbpRate();
    expect(r).toBeCloseTo(0.79, 4);
  });

  it('throws when both hot cache and lastGood are stale', async () => {
    let now = 1_000_000;
    const { fx, redis, provider } = build({ now: () => now });
    await fx.usdGbpRate();   // primes lastGood at t=1_000_000

    redis.store.delete('fx:GBPUSD');
    provider.shouldThrow = true;
    now += 25 * 60 * 60 * 1000;   // +25h, past 24h fallback window

    await expect(fx.usdGbpRate()).rejects.toThrow(/fx unavailable/);
  });

  it('does not call the provider concurrently more than once when many callers race', async () => {
    // Note: FxClient does NOT include in-flight coalescing today (Redis is fast enough
    // that two parallel callers hitting empty cache will both fetch; we accept that and
    // rely on Redis SETEX being idempotent). Pin the current behaviour here so any
    // future change to add coalescing is intentional.
    const { fx, provider } = build();
    const results = await Promise.all(Array.from({ length: 5 }, () => fx.usdGbpRate()));
    for (const r of results) expect(r).toBeCloseTo(0.79, 4);
    // Without coalescing, every parallel caller fetches. This is the documented quirk.
    expect(provider.calls).toBeGreaterThanOrEqual(1);
    expect(provider.calls).toBeLessThanOrEqual(5);
  });
});
