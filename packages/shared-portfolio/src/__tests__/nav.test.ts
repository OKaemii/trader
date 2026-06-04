import { describe, it, expect } from "vitest";
import { sumPositionsGBP, sumOpenPnlGBP, type FxConverter, type PositionDoc } from '../nav.ts';
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

describe('sumOpenPnlGBP', () => {
  it('computes market value − cost basis per position (GBP-only)', async () => {
    const positions: PositionDoc[] = [
      // 10 @ avg 8 = cost 80; value 100 → +20
      { ticker: 'VOD_l_EQ', quantity: 10, averagePrice: { amount: 8, currency: 'GBP' }, currentValue: { amount: 100, currency: 'GBP' } },
      // 5 @ avg 20 = cost 100; value 90 → -10
      { ticker: 'BP_l_EQ',  quantity: 5,  averagePrice: { amount: 20, currency: 'GBP' }, currentValue: { amount: 90,  currency: 'GBP' } },
    ];
    const r = await sumOpenPnlGBP(positions, makeFx());
    expect(r.pnlGbp).toBeCloseTo(10, 9);          // +20 − 10
    expect(r.costBasisGbp).toBeCloseTo(180, 9);
    expect(r.marketValueGbp).toBeCloseTo(190, 9);
    expect(r.covered).toBe(2);
    expect(r.total).toBe(2);
  });

  it('FX-converts USD cost basis and value to GBP consistently', async () => {
    const positions: PositionDoc[] = [
      // 4 @ avg 100 = cost $400; value $500 → +$100 → +£79 at 0.79
      { ticker: 'AAPL_US_EQ', quantity: 4, averagePrice: { amount: 100, currency: 'USD' }, currentValue: { amount: 500, currency: 'USD' } },
    ];
    const r = await sumOpenPnlGBP(positions, makeFx(0.79));
    expect(r.pnlGbp).toBeCloseTo(79, 9);
    expect(r.costBasisGbp).toBeCloseTo(316, 9);    // 400 * 0.79
  });

  it('skips positions without a cost basis (no fabricated 100% gain) and reports coverage', async () => {
    const positions: PositionDoc[] = [
      { ticker: 'A_l_EQ', quantity: 10, averagePrice: { amount: 8, currency: 'GBP' }, currentValue: { amount: 100, currency: 'GBP' } }, // +20, covered
      { ticker: 'B_l_EQ', quantity: 5, currentValue: { amount: 90, currency: 'GBP' } },                                                // no averagePrice → skipped
    ];
    const r = await sumOpenPnlGBP(positions, makeFx());
    expect(r.pnlGbp).toBeCloseTo(20, 9);    // only the covered position contributes
    expect(r.covered).toBe(1);
    expect(r.total).toBe(2);
  });

  it('returns zeros for empty positions', async () => {
    const r = await sumOpenPnlGBP([], makeFx());
    expect(r).toEqual({ pnlGbp: 0, costBasisGbp: 0, marketValueGbp: 0, covered: 0, total: 0 });
  });
});
