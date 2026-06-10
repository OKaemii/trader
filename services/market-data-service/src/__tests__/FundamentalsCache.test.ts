import { describe, expect, it, vi } from 'vitest';
import { FundamentalsCache } from '../modules/fundamentals/application/FundamentalsCache.ts';
import type { FundamentalsProvider } from '../modules/fundamentals/infrastructure/FundamentalsProvider.ts';

// refreshIfModeChanged is the fix for the capstone defect: flipping FUNDAMENTALS_PROVIDER (yahoo→pit)
// doesn't make cached company_fundamentals rows time-stale, so the TTL refresher leaves the
// Research/Scanner surfaces serving the OLD provider's data for up to a month. The cache now
// re-sources the universe once when the mode changes. The DECISION is the unit here — `refresh` is
// spied so neither the provider nor Mongo is exercised.

const noopProvider: FundamentalsProvider = { fetch: async () => ({}) };

function fakeModeStore(initial: string | null) {
  const m = new Map<string, string>();
  if (initial !== null) m.set(FundamentalsCache.MODE_KEY, initial);
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => { m.set(k, v); return 'OK'; },
    peek: () => m.get(FundamentalsCache.MODE_KEY) ?? null,
  };
}

describe('FundamentalsCache.refreshIfModeChanged (re-source on a provider-mode flip)', () => {
  it('re-sources + records the mode on first boot with the fix (no prior mode)', async () => {
    const cache = new FundamentalsCache(noopProvider, 'pit');
    const refresh = vi.spyOn(cache, 'refresh').mockResolvedValue(28);
    const store = fakeModeStore(null);

    const r = await cache.refreshIfModeChanged(store, ['AAPL_US_EQ', 'MSFT_US_EQ']);

    expect(r).toEqual({ changed: true, from: null, refreshed: 28 });
    expect(refresh).toHaveBeenCalledWith(['AAPL_US_EQ', 'MSFT_US_EQ']);
    expect(store.peek()).toBe('pit'); // mode recorded so the next boot is a no-op
  });

  it('re-sources on a yahoo→pit flip', async () => {
    const cache = new FundamentalsCache(noopProvider, 'pit');
    const refresh = vi.spyOn(cache, 'refresh').mockResolvedValue(28);
    const store = fakeModeStore('yahoo');

    const r = await cache.refreshIfModeChanged(store, ['AAPL_US_EQ']);

    expect(r.changed).toBe(true);
    expect(r.from).toBe('yahoo');
    expect(refresh).toHaveBeenCalledOnce();
    expect(store.peek()).toBe('pit');
  });

  it('is a no-op when the mode is unchanged (steady-state boot)', async () => {
    const cache = new FundamentalsCache(noopProvider, 'pit');
    const refresh = vi.spyOn(cache, 'refresh').mockResolvedValue(0);
    const store = fakeModeStore('pit');

    const r = await cache.refreshIfModeChanged(store, ['AAPL_US_EQ']);

    expect(r).toEqual({ changed: false, from: 'pit', refreshed: 0 });
    expect(refresh).not.toHaveBeenCalled(); // never re-sources on steady state
  });

  it('does NOT advance the mode key if the refresh throws (retries next boot)', async () => {
    const cache = new FundamentalsCache(noopProvider, 'pit');
    vi.spyOn(cache, 'refresh').mockRejectedValue(new Error('provider down'));
    const store = fakeModeStore('yahoo');

    await expect(cache.refreshIfModeChanged(store, ['AAPL_US_EQ'])).rejects.toThrow('provider down');
    expect(store.peek()).toBe('yahoo'); // unchanged → the flip is re-attempted on the next boot
  });
});
