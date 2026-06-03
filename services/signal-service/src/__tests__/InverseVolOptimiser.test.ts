// Golden-vector parity for the inverse-vol optimiser. Mirrors quant-core's test_inverse_vol.py
// case-for-case (same numeric expectations) so the live TS path and replay Python path agree.

import { describe, it, expect } from 'vitest';
import { solveInverseVol } from '../modules/signals/application/InverseVolOptimiser.ts';

describe('solveInverseVol (parity with quant-core solve_inverse_vol)', () => {
  it('lower vol gets higher weight; sums to 1', () => {
    // vols [0.1, 0.2, 0.4] → inv [10, 5, 2.5] → sum 17.5
    const w = solveInverseVol({ volatilities: [0.1, 0.2, 0.4], tickers: ['A', 'B', 'C'], currentWeights: [0, 0, 0] });
    expect(w[0]!).toBeGreaterThan(w[1]!);
    expect(w[1]!).toBeGreaterThan(w[2]!);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(w[0]!).toBeCloseTo(10 / 17.5, 9);
    expect(w[1]!).toBeCloseTo(5 / 17.5, 9);
    expect(w[2]!).toBeCloseTo(2.5 / 17.5, 9);
  });

  it('excludes zero / non-finite vol', () => {
    const w = solveInverseVol({ volatilities: [0, Infinity, 0.2], tickers: ['A', 'B', 'C'], currentWeights: [0, 0, 0] });
    expect(w[0]).toBe(0);
    expect(w[1]).toBe(0);
    expect(w[2]!).toBeCloseTo(1, 9);
  });

  it('all zero when no valid vol', () => {
    expect(solveInverseVol({ volatilities: [0, 0], tickers: ['A', 'B'], currentWeights: [0, 0] })).toEqual([0, 0]);
  });

  it('full rebalance at the default budget', () => {
    const w = solveInverseVol({ volatilities: [0.1, 0.1], tickers: ['A', 'B'], currentWeights: [1, 0] });
    expect(w[0]!).toBeCloseTo(0.5, 9);
    expect(w[1]!).toBeCloseTo(0.5, 9);
  });

  it('monthly turnover blend throttles', () => {
    const w = solveInverseVol({ volatilities: [0.1, 0.1], tickers: ['A', 'B'], currentWeights: [1, 0], maxMonthlyTurnover: 0.1 });
    const turnover = (Math.abs(w[0]! - 1) + Math.abs(w[1]! - 0)) / 2;
    expect(turnover).toBeLessThanOrEqual(0.1 + 1e-9);
  });
});
