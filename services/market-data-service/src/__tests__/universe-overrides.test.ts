import { describe, it, expect } from 'bun:test';
import { applyUniverseOverrides, type InstrumentMeta } from '../universe-manager.ts';

function inst(ticker: string, sector = 'Tech'): InstrumentMeta {
  return { ticker, name: ticker, sector, t212Tradable: true };
}

describe('applyUniverseOverrides', () => {
  const base = [inst('AAPL'), inst('MSFT'), inst('GOOGL')];

  it('returns input unchanged when overrides is null', () => {
    const { result, added, removed } = applyUniverseOverrides(base, null);
    expect(result.map((i) => i.ticker)).toEqual(['AAPL', 'MSFT', 'GOOGL']);
    expect(added).toBe(0);
    expect(removed).toBe(0);
  });

  it('removes tickers listed in removes (case-insensitive)', () => {
    const { result, removed } = applyUniverseOverrides(base, { removes: ['aapl'] });
    expect(result.map((i) => i.ticker)).toEqual(['MSFT', 'GOOGL']);
    expect(removed).toBe(1);
  });

  it('appends adds not already present, marked t212Tradable=false', () => {
    const { result, added } = applyUniverseOverrides(base, { adds: ['NVDA', 'TSLA'] });
    expect(added).toBe(2);
    const nvda = result.find((i) => i.ticker === 'NVDA');
    expect(nvda).toBeDefined();
    expect(nvda?.t212Tradable).toBe(false);
    expect(nvda?.sector).toBe('Unknown');
  });

  it('deduplicates adds already present in selection', () => {
    const { result, added } = applyUniverseOverrides(base, { adds: ['AAPL', 'NVDA'] });
    expect(added).toBe(1);
    expect(result.filter((i) => i.ticker === 'AAPL')).toHaveLength(1);
  });

  it('applies removes before adds (a ticker in both is added back)', () => {
    const { result, added, removed } = applyUniverseOverrides(base, {
      removes: ['AAPL'],
      adds: ['AAPL'],
    });
    expect(removed).toBe(1);
    expect(added).toBe(1);
    const aapl = result.find((i) => i.ticker === 'AAPL');
    expect(aapl?.t212Tradable).toBe(false);
  });

  it('ignores empty / whitespace tickers in adds', () => {
    const { added } = applyUniverseOverrides(base, { adds: ['', '  ', 'NVDA'] });
    expect(added).toBe(1);
  });

  it('handles missing adds/removes fields', () => {
    const { result, added, removed } = applyUniverseOverrides(base, {});
    expect(result).toHaveLength(3);
    expect(added).toBe(0);
    expect(removed).toBe(0);
  });
});
