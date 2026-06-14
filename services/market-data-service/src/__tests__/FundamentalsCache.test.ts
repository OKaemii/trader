import { describe, expect, it, vi } from 'vitest';
import { FundamentalsCache } from '../modules/fundamentals/application/FundamentalsCache.ts';
import type { FundamentalsProvider } from '../modules/fundamentals/infrastructure/FundamentalsProvider.ts';

// refreshIfModeChanged is the fix for the capstone defect: flipping FUNDAMENTALS_PROVIDER (yahoo→pit)
// doesn't make cached company_fundamentals rows time-stale, so the TTL refresher leaves the
// Research/Scanner surfaces serving the OLD provider's data for up to a month. The cache now
// re-sources the universe once when the mode changes. The DECISION is the unit here — `refresh` is
// spied so neither the provider nor Mongo is exercised.

const noopProvider: FundamentalsProvider = { fetch: async () => ({ values: {}, status: {} }) };

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

  it('re-sources US names FIRST and in chunks (a slow non-US tail cannot block US writes)', async () => {
    const cache = new FundamentalsCache(noopProvider, 'pit');
    const seen: string[][] = [];
    vi.spyOn(cache, 'refresh').mockImplementation(async (t) => { seen.push(t); return t.length; });
    const store = fakeModeStore('yahoo');
    // 13 US + 1 LSE → chunk size 12 means: chunk1 = 12 US, chunk2 = 1 US + the LSE last.
    const us = Array.from({ length: 13 }, (_, i) => `US${i}_US_EQ`);
    const tickers = ['VODl_EQ', ...us]; // LSE listed first to prove it is reordered LAST

    const r = await cache.refreshIfModeChanged(store, tickers);

    expect(r.refreshed).toBe(14);
    expect(seen).toHaveLength(2);            // 14 tickers / chunk 12 → 2 chunks
    expect(seen[0]).toHaveLength(12);
    expect(seen[0].every((t) => t.endsWith('_US_EQ'))).toBe(true); // first chunk is all US
    expect(seen[1][seen[1].length - 1]).toBe('VODl_EQ');           // the LSE name is dead last
    expect(store.peek()).toBe('pit');
  });

  it('records the mode after PARTIAL progress (a bad chunk is skipped, not fatal)', async () => {
    const cache = new FundamentalsCache(noopProvider, 'pit');
    let call = 0;
    vi.spyOn(cache, 'refresh').mockImplementation(async (t) => {
      call += 1;
      if (call === 2) throw new Error('yahoo cooldown'); // the non-US tail chunk throws
      return t.length;
    });
    const store = fakeModeStore('yahoo');
    const us = Array.from({ length: 13 }, (_, i) => `US${i}_US_EQ`);

    const r = await cache.refreshIfModeChanged(store, [...us, 'VODl_EQ']);

    expect(r.changed).toBe(true);
    expect(r.refreshed).toBe(12);     // chunk1 (12 US) succeeded; chunk2 threw → counted 0
    expect(store.peek()).toBe('pit'); // partial progress still records the mode
  });

  it('does NOT advance the mode key when EVERY chunk fails (retries next boot)', async () => {
    const cache = new FundamentalsCache(noopProvider, 'pit');
    vi.spyOn(cache, 'refresh').mockRejectedValue(new Error('provider down'));
    const store = fakeModeStore('yahoo');

    const r = await cache.refreshIfModeChanged(store, ['AAPL_US_EQ']);

    expect(r.changed).toBe(true);
    expect(r.refreshed).toBe(0);      // nothing re-sourced
    expect(store.peek()).toBe('yahoo'); // mode unchanged → the flip is re-attempted on the next boot
  });
});
