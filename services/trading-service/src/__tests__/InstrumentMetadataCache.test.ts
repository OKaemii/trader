import { describe, it, expect } from 'vitest';
import {
  applyQuantityRules,
  decimalsOf,
  InstrumentMetadataCache,
} from '../modules/t212/infrastructure/InstrumentMetadataCache.ts';
import type { Trading212Client, T212Instrument } from '../modules/t212/infrastructure/Trading212Client.ts';
import type { Logger } from '@trader/core';

const silentLogger: Logger = {
  info:  () => {}, warn: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
  error: () => {}, child: () => silentLogger, level: 'info',
} as unknown as Logger;

describe('decimalsOf', () => {
  it('handles whole-share minima', () => {
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(100)).toBe(0);
  });
  it('handles two-decimal minima', () => {
    expect(decimalsOf(0.01)).toBe(2);
  });
  it('handles three-decimal minima', () => {
    expect(decimalsOf(0.001)).toBe(3);
  });
  it('handles irregular minima from real T212 responses', () => {
    // From an actual broker rejection: "must trade at least 0.01510719"
    expect(decimalsOf(0.01510719)).toBe(8);
  });
  it('treats zero / non-finite as zero', () => {
    expect(decimalsOf(0)).toBe(0);
    expect(decimalsOf(NaN)).toBe(0);
    expect(decimalsOf(Infinity)).toBe(0);
  });
});

describe('applyQuantityRules', () => {
  it('floors to precision', () => {
    expect(applyQuantityRules(0.4267, { minQuantity: 0.001, precision: 3 })).toBeCloseTo(0.426, 5);
  });
  it('returns 0 when floored qty below minQuantity', () => {
    expect(applyQuantityRules(0.02, { minQuantity: 0.05, precision: 2 })).toBe(0);
  });
  it('returns 0 for non-positive inputs', () => {
    expect(applyQuantityRules(0, { minQuantity: 0.01, precision: 2 })).toBe(0);
    expect(applyQuantityRules(-1, { minQuantity: 0.01, precision: 2 })).toBe(0);
  });
  it('whole-share precision drops the fractional component', () => {
    expect(applyQuantityRules(3.99, { minQuantity: 1, precision: 0 })).toBe(3);
    expect(applyQuantityRules(0.99, { minQuantity: 1, precision: 0 })).toBe(0);
  });
});

function fakeClient(instruments: T212Instrument[]): Trading212Client {
  return { getInstruments: async () => instruments } as unknown as Trading212Client;
}

describe('InstrumentMetadataCache', () => {
  it('respects an explicit precision field on the metadata payload', async () => {
    // When T212 (or a future authenticated endpoint) ever surfaces per-ticker precision,
    // the cache must carry it through verbatim. Validates the parse path stays honest
    // once real data arrives.
    const cache = new InstrumentMetadataCache(
      fakeClient([
        { ticker: 'AAPL_US_EQ', minTradeQuantity: 0.01, maxOpenQuantity: 1e6, currencyCode: 'USD', type: 'STOCK', precision: 4 },
        { ticker: 'SUPRl_EQ',   minTradeQuantity: 0.01510719, maxOpenQuantity: 1e6, currencyCode: 'GBP', type: 'ETF', precision: 8 },
      ]),
      silentLogger,
    );
    await cache.load();
    expect(await cache.getRules('AAPL_US_EQ')).toEqual({ minQuantity: 0.01, precision: 4 });
    expect(await cache.getRules('SUPRl_EQ')).toEqual({ minQuantity: 0.01510719, precision: 8 });
  });

  it('applies DEFAULT_PRECISION (2) when T212 omits the precision field', async () => {
    // Reflects the current production reality: T212's public metadata endpoint does
    // not expose precision at all. Cache defaults to precision 2 — coarse enough to
    // satisfy LSE GBX names (LANDl/SBRYl/BMEl/CNAl all require ≤ 2) without bricking
    // anything that accepts more precision.
    const cache = new InstrumentMetadataCache(
      fakeClient([
        { ticker: 'LANDl_EQ', minTradeQuantity: 0, maxOpenQuantity: 1e6, currencyCode: 'GBX', type: 'STOCK' },
        { ticker: 'CVX_US_EQ', minTradeQuantity: 0, maxOpenQuantity: 1e6, currencyCode: 'USD', type: 'STOCK' },
      ]),
      silentLogger,
    );
    await cache.load();
    expect(await cache.getRules('LANDl_EQ')).toEqual({ minQuantity: 0.01, precision: 2 });
    expect(await cache.getRules('CVX_US_EQ')).toEqual({ minQuantity: 0.01, precision: 2 });
    // Sanity: with precision 2, qty 10.2242 floors to 10.22 (matches what T212
    // accepts for LANDl). The pre-fix path floored to 10.2242 and got rejected.
    expect(applyQuantityRules(10.2242, await cache.getRules('LANDl_EQ'))).toBeCloseTo(10.22, 4);
  });

  it('returns the same fallback rules for unknown tickers', async () => {
    const cache = new InstrumentMetadataCache(fakeClient([]), silentLogger);
    await cache.load();
    expect(await cache.getRules('NEWl_EQ')).toEqual({ minQuantity: 0.01, precision: 2 });
  });

  it('still parses an explicit minTradeQuantity when precision is missing', async () => {
    // The two fields are independent: T212 may provide one without the other.
    // minQuantity overrides the default-derived floor; precision still falls back to 2.
    const cache = new InstrumentMetadataCache(
      fakeClient([
        { ticker: 'WEIRDl_EQ', minTradeQuantity: 5, maxOpenQuantity: 1e6, currencyCode: 'GBX', type: 'STOCK' },
      ]),
      silentLogger,
    );
    await cache.load();
    expect(await cache.getRules('WEIRDl_EQ')).toEqual({ minQuantity: 5, precision: 2 });
  });

  it('coalesces concurrent load() calls', async () => {
    let calls = 0;
    const client = {
      getInstruments: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return [];
      },
    } as unknown as Trading212Client;
    const cache = new InstrumentMetadataCache(client, silentLogger);
    await Promise.all([cache.load(), cache.load(), cache.load()]);
    expect(calls).toBe(1);
  });
});
