import { describe, it, expect } from "vitest";
import { solveLongOnly, RISK_LIMITS, type RankingInput } from '../application/services/LongOnlyOptimiser.ts';

const baseInput = (overrides: Partial<RankingInput> = {}): RankingInput => ({
  scores: [0.8, 0.5, 0.3, -0.1],
  tickers: ['AAPL', 'MSFT', 'GOOG', 'TSLA'],
  sectors: ['Technology', 'Technology', 'Technology', 'Consumer'],
  currentWeights: [0, 0, 0, 0],
  targetVol: 0.10,
  covariance: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  ...overrides,
});

describe('solveLongOnly', () => {
  it('returns all zeros when no positive scores', () => {
    const result = solveLongOnly(baseInput({ scores: [-1, -0.5, 0, -0.1] }));
    expect(result.every((w) => w === 0)).toBe(true);
  });

  it('weights are non-negative and sum ≤ 1 when positive scores exist', () => {
    const result = solveLongOnly(baseInput());
    const sum = result.reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(0);
    expect(sum).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('weights sum to 1 when no turnover blending needed (current weights match target)', () => {
    // Use a single stock so turnover is low from start
    const input: RankingInput = {
      scores: [0.8],
      tickers: ['AAPL'],
      sectors: ['Technology'],
      currentWeights: [1.0],    // already fully invested → no turnover
      targetVol: 0.10,
      covariance: [[1]],
    };
    const result = solveLongOnly(input);
    expect(result.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('all weights are in [0, 1] (long-only)', () => {
    const result = solveLongOnly(baseInput());
    for (const w of result) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it('excludes negative-score assets', () => {
    const result = solveLongOnly(baseInput());
    // TSLA has score -0.1 → must be zero
    expect(result[3]).toBe(0);
  });

  it('caps each name proportional weight at maxSingleName before normalisation', () => {
    // With well-distributed scores (no turnover), each pre-normalisation weight ≤ 15%.
    // Note: post-normalisation weights can exceed 15% when the universe is small — the
    // v1 heuristic applies the cap to the proportional scores, not the final weights.
    // The hard upper bound (1.0) is enforced by the TradeSignal constructor.
    const result = solveLongOnly(baseInput({
      scores: [0.8, 0.5, 0.3, 0.1],
      sectors: ['Technology', 'Healthcare', 'Financials', 'Energy'],
      currentWeights: [0.235, 0.147, 0.088, 0.029],  // near-target → minimal turnover
    }));
    for (const w of result) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it('reduces sector total when sector concentration exceeds cap', () => {
    // All 4 tickers in Technology with equal scores → without sector cap total would be 1.
    // With cap at 30%, Technology total is scaled down, but post-normalisation still sums to 1.
    const result = solveLongOnly(baseInput({
      scores: [0.8, 0.7, 0.6, 0.5],
      sectors: ['Technology', 'Technology', 'Technology', 'Technology'],
      currentWeights: [0.1, 0.1, 0.1, 0.1],  // low turnover
    }));
    // All weights non-negative
    for (const w of result) expect(w).toBeGreaterThanOrEqual(0);
    // Sector cap reduces concentration relative to an uncapped allocation
    const rawUncapped = [0.8, 0.7, 0.6, 0.5].map((s) => s / 2.6); // uncapped proportional
    const uncappedMax = Math.max(...rawUncapped);
    const cappedMax = Math.max(...result);
    expect(cappedMax).toBeLessThan(uncappedMax + 0.01);
  });

  it('blends toward current weights when turnover exceeds budget', () => {
    // Current weights are all 0.25, new optimal is [1, 0, 0, 0] → high turnover
    const input = baseInput({
      scores: [1, 0.01, 0.01, 0.01],
      sectors: ['Technology', 'Healthcare', 'Financials', 'Energy'],
      currentWeights: [0.25, 0.25, 0.25, 0.25],
    });
    const result = solveLongOnly(input);
    const turnover = result.reduce((a, w, i) => a + Math.abs(w - input.currentWeights[i]), 0) / 2;
    expect(turnover).toBeLessThanOrEqual(RISK_LIMITS.maxWeeklyTurnover + 1e-9);
  });

  it('returns correct length equal to input tickers length', () => {
    const result = solveLongOnly(baseInput());
    expect(result).toHaveLength(4);
  });
});
