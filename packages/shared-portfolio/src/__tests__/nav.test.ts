import { describe, it, expect } from "vitest";
import { sumPositionsGBP, type FxConverter, type PositionDoc } from '../nav.ts';
import type { Money } from '@trader/shared-types';

function makeFx(rateGbpPerUsd = 0.79, shouldThrow = false): FxConverter {
  return {
    async toGBP(m: Money): Promise<number> {
      if (shouldThrow) throw new Error('fx unavailable');
      if (m.currency === 'GBP') return m.amount;
      if (m.currency === 'USD') return m.amount * rateGbpPerUsd;
      throw new Error(`unsupported currency ${m.currency}`);
    },
  };
}

describe('sumPositionsGBP', () => {
  it('sums GBP-only positions as identity', async () => {
    const positions: PositionDoc[] = [
      { ticker: 'VOD_l_EQ', currentValue: { amount: 100, currency: 'GBP' } },
      { ticker: 'BP_l_EQ',  currentValue: { amount: 250, currency: 'GBP' } },
    ];
    const total = await sumPositionsGBP(positions, makeFx());
    expect(total).toBe(350);
  });

  it('FX-converts USD positions to GBP', async () => {
    const positions: PositionDoc[] = [
      { ticker: 'AAPL_US_EQ', currentValue: { amount: 1000, currency: 'USD' } },
    ];
    const total = await sumPositionsGBP(positions, makeFx(0.8));
    expect(total).toBeCloseTo(800, 4);
  });

  it('sums mixed-currency positions correctly', async () => {
    const positions: PositionDoc[] = [
      { ticker: 'VOD_l_EQ',   currentValue: { amount: 100, currency: 'GBP' } },
      { ticker: 'AAPL_US_EQ', currentValue: { amount: 100, currency: 'USD' } },
    ];
    const total = await sumPositionsGBP(positions, makeFx(0.8));
    expect(total).toBeCloseTo(180, 4);
  });

  it('throws when FX is unavailable — does not silently substitute native scalar', async () => {
    const positions: PositionDoc[] = [
      { ticker: 'AAPL_US_EQ', currentValue: { amount: 1000, currency: 'USD' } },
    ];
    expect(sumPositionsGBP(positions, makeFx(0.8, true))).rejects.toThrow('fx unavailable');
  });

  it('skips rows with missing currentValue (treated as 0 contribution)', async () => {
    const positions: PositionDoc[] = [
      { ticker: 'VOD_l_EQ',   currentValue: { amount: 100, currency: 'GBP' } },
      { ticker: 'NEW_TICKER', /* no currentValue yet */ },
    ];
    const total = await sumPositionsGBP(positions, makeFx());
    expect(total).toBe(100);
  });

  it('skips rows with non-positive or malformed amount', async () => {
    const positions: PositionDoc[] = [
      { ticker: 'VOD_l_EQ',   currentValue: { amount: 100, currency: 'GBP' } },
      { ticker: 'ZERO',       currentValue: { amount: 0,   currency: 'GBP' } },
      { ticker: 'NEG',        currentValue: { amount: -50, currency: 'GBP' } },
      // Missing currency tag — treated as malformed.
      { ticker: 'NOCURR',     currentValue: { amount: 99,  currency: undefined as any } },
    ];
    const total = await sumPositionsGBP(positions, makeFx());
    expect(total).toBe(100);
  });

  it('returns 0 for empty positions array', async () => {
    const total = await sumPositionsGBP([], makeFx());
    expect(total).toBe(0);
  });
});
