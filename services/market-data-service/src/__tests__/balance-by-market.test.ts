import { describe, it, expect } from "vitest";
import { balanceByMarket } from '../modules/universe/application/UniverseManager.ts';

type Item = { ticker: string; market: 'US' | 'LSE'; marketCapGbp: number };
const mk = (n: number, market: 'US' | 'LSE'): Item[] =>
  Array.from({ length: n }, (_, i) => ({
    ticker: `${market}${i}`,
    market,
    // Descending caps, with US strictly larger than LSE so a naive global sort would be US-only.
    marketCapGbp: market === 'US' ? 1_000_000 - i : 100_000 - i,
  }));

describe('balanceByMarket', () => {
  it('splits evenly: 100 US / 100 LSE at maxSize=200 even when US caps dwarf LSE', () => {
    const out = balanceByMarket([...mk(400, 'US'), ...mk(400, 'LSE')], 200);
    expect(out.length).toBe(200);
    expect(out.filter((i) => i.market === 'US').length).toBe(100);
    expect(out.filter((i) => i.market === 'LSE').length).toBe(100);
  });

  it('picks the highest-cap names within each market', () => {
    const out = balanceByMarket([...mk(5, 'US'), ...mk(5, 'LSE')], 4);
    // perMarket = 2 → top-2 of each by cap (index 0,1 are largest).
    expect(out.filter((i) => i.market === 'US').map((i) => i.ticker)).toEqual(['US0', 'US1']);
    expect(out.filter((i) => i.market === 'LSE').map((i) => i.ticker)).toEqual(['LSE0', 'LSE1']);
  });

  it('backfills from US when LSE is short of its half', () => {
    // Only 10 LSE names clear the floor; target is 100 each at maxSize=200 → fill the rest from US.
    const out = balanceByMarket([...mk(400, 'US'), ...mk(10, 'LSE')], 200);
    expect(out.length).toBe(200);
    expect(out.filter((i) => i.market === 'LSE').length).toBe(10);
    expect(out.filter((i) => i.market === 'US').length).toBe(190);
  });

  it('backfills from LSE when US is short (symmetric)', () => {
    const out = balanceByMarket([...mk(10, 'US'), ...mk(400, 'LSE')], 200);
    expect(out.length).toBe(200);
    expect(out.filter((i) => i.market === 'US').length).toBe(10);
    expect(out.filter((i) => i.market === 'LSE').length).toBe(190);
  });

  it('returns everything (no padding) when total available is below maxSize', () => {
    const out = balanceByMarket([...mk(30, 'US'), ...mk(20, 'LSE')], 200);
    expect(out.length).toBe(50);
  });

  it('handles odd maxSize without overshooting the cap', () => {
    const out = balanceByMarket([...mk(100, 'US'), ...mk(100, 'LSE')], 7);
    expect(out.length).toBe(7); // floor(7/2)=3 each → 6, then 1 backfill
  });

  it('returns empty for non-positive maxSize', () => {
    expect(balanceByMarket([...mk(10, 'US')], 0)).toEqual([]);
    expect(balanceByMarket([...mk(10, 'US')], -5)).toEqual([]);
  });
});
