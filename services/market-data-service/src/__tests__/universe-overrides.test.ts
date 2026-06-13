import { describe, it, expect } from "vitest";
import { Trading212TickerAdapter, type Market } from '@trader/ticker-identity';
import {
  applyUniverseOverrides, type InstrumentMeta, type OverrideEntry,
} from '../modules/universe/application/UniverseManager.ts';

// Native to the bare (symbol, market) identity since Task 18: applyUniverseOverrides operates on
// OverrideEntry { symbol, market } and InstrumentMeta carries symbol+market+the derived T212 ticker.
const adapter = new Trading212TickerAdapter();
function inst(symbol: string, market: Market = 'US', sector = 'Tech'): InstrumentMeta {
  return { symbol, market, ticker: adapter.toT212({ symbol, market }), name: symbol, sector, t212Tradable: true };
}
function entry(symbol: string, market: Market = 'US'): OverrideEntry { return { symbol, market }; }

describe('applyUniverseOverrides', () => {
  const base = [inst('AAPL'), inst('MSFT'), inst('GOOGL')];

  it('returns input unchanged when overrides is null', () => {
    const { result, added, removed } = applyUniverseOverrides(base, null);
    expect(result.map((i) => i.symbol)).toEqual(['AAPL', 'MSFT', 'GOOGL']);
    expect(added).toBe(0);
    expect(removed).toBe(0);
  });

  it('removes entries matched on (symbol, market)', () => {
    const { result, removed } = applyUniverseOverrides(base, { removes: [entry('AAPL')] });
    expect(result.map((i) => i.symbol)).toEqual(['MSFT', 'GOOGL']);
    expect(removed).toBe(1);
  });

  it('does NOT remove a same-symbol entry on a different market (market disambiguates)', () => {
    // {SHEL, US} in the selection must not be removed by a {SHEL, LSE} override — the cross-listing
    // ambiguity a single T212 string couldn't express is resolved by the (symbol, market) key.
    const lseBase = [inst('SHEL', 'US'), inst('BP', 'US')];
    const { result, removed } = applyUniverseOverrides(lseBase, { removes: [entry('SHEL', 'LSE')] });
    expect(result.map((i) => i.symbol)).toEqual(['SHEL', 'BP']);
    expect(removed).toBe(0);
  });

  it('appends adds not already present, marked t212Tradable=false with the derived ticker', () => {
    const { result, added } = applyUniverseOverrides(base, { adds: [entry('NVDA'), entry('TSLA')] });
    expect(added).toBe(2);
    const nvda = result.find((i) => i.symbol === 'NVDA');
    expect(nvda).toBeDefined();
    expect(nvda?.t212Tradable).toBe(false);
    expect(nvda?.sector).toBe('Unknown');
    expect(nvda?.market).toBe('US');
    expect(nvda?.ticker).toBe('NVDA_US_EQ');   // the derived broker form
  });

  it('appends an LSE add with the LSE-suffixed derived ticker', () => {
    const { result, added } = applyUniverseOverrides(base, { adds: [entry('SHEL', 'LSE')] });
    expect(added).toBe(1);
    const shel = result.find((i) => i.symbol === 'SHEL');
    expect(shel?.market).toBe('LSE');
    expect(shel?.ticker).toBe('SHELl_EQ');
  });

  it('deduplicates adds already present in selection (on (symbol, market))', () => {
    const { result, added } = applyUniverseOverrides(base, { adds: [entry('AAPL'), entry('NVDA')] });
    expect(added).toBe(1);
    expect(result.filter((i) => i.symbol === 'AAPL')).toHaveLength(1);
  });

  it('applies removes before adds (a (symbol, market) in both is added back, non-tradable)', () => {
    const { result, added, removed } = applyUniverseOverrides(base, {
      removes: [entry('AAPL')],
      adds: [entry('AAPL')],
    });
    expect(removed).toBe(1);
    expect(added).toBe(1);
    const aapl = result.find((i) => i.symbol === 'AAPL');
    expect(aapl?.t212Tradable).toBe(false);
  });

  it('ignores empty-symbol / unsupported-market entries in adds', () => {
    const { added } = applyUniverseOverrides(base, {
      adds: [entry(''), { symbol: 'X', market: 'OTHER' as Market }, entry('NVDA')],
    });
    expect(added).toBe(1);
  });

  it('handles missing adds/removes fields', () => {
    const { result, added, removed } = applyUniverseOverrides(base, {});
    expect(result).toHaveLength(3);
    expect(added).toBe(0);
    expect(removed).toBe(0);
  });
});
