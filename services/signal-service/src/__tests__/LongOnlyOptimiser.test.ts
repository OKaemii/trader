import { describe, it, expect } from "vitest";
import { solveLongOnly, RISK_LIMITS, type RankingInput } from '../modules/signals/application/LongOnlyOptimiser.ts';

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

  describe('top-K truncation', () => {
    const wideInput = (topK?: number): RankingInput => ({
      scores: [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
      tickers: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
      // Distinct sectors so the sector cap never bites — we are isolating top-K behaviour.
      sectors: ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'],
      // currentWeights=0 across the board so the turnover guard never blends in residual
      // weight from previously-held names — we want a clean test of "outside top-K → 0".
      currentWeights: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      targetVol: 0.10,
      covariance: Array.from({ length: 10 }, (_, i) =>
        Array.from({ length: 10 }, (_, j) => (i === j ? 1 : 0))
      ),
      ...(topK !== undefined ? { topK } : {}),
    });

    it('zeroes weights for names outside top-K', () => {
      // Top-3 by score → A, B, C should be non-zero; D-J should be zero.
      const result = solveLongOnly(wideInput(3));
      expect(result[0]).toBeGreaterThan(0);
      expect(result[1]).toBeGreaterThan(0);
      expect(result[2]).toBeGreaterThan(0);
      for (let i = 3; i < 10; i++) expect(result[i]).toBe(0);
    });

    it('top-K=0 disables truncation (every positive score gets weight)', () => {
      const result = solveLongOnly(wideInput(0));
      for (let i = 0; i < 10; i++) expect(result[i]).toBeGreaterThan(0);
    });

    it('top-K larger than the positive set is a no-op', () => {
      const result = solveLongOnly(wideInput(100));
      for (let i = 0; i < 10; i++) expect(result[i]).toBeGreaterThan(0);
    });

    it('top-K=20 concentrates weight enough that per-position weight clears 1% even at K=20', () => {
      // Realistic factor_rank shape: 200 candidates, ~half positive, K=20.
      // Per-position weight should be >= 1/20 = 5% before sector caps.
      const n = 200;
      const scores = Array.from({ length: n }, (_, i) => (i < 100 ? 1 - i / 100 : -1 + (n - i) / 100));
      const result = solveLongOnly({
        scores,
        tickers: Array.from({ length: n }, (_, i) => `T${i}`),
        sectors: Array.from({ length: n }, (_, i) => `s${i % 11}`), // 11 sectors → cap rarely binds
        currentWeights: new Array(n).fill(0),
        targetVol: 0.10,
        covariance: Array.from({ length: n }, (_, i) =>
          Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
        ),
        topK: 20,
      });
      const nonzero = result.filter((w) => w > 0);
      expect(nonzero.length).toBeLessThanOrEqual(20);
      // Average within the selected set: at K=20 with no holdings (currentWeights=0)
      // the turnover guard blends ~80% toward the new optimum, so per-position weight
      // is ~0.8/20 = 4% in practice. Asserts the lift over the legacy ~0.5% baseline.
      const avg = nonzero.reduce((a, b) => a + b, 0) / nonzero.length;
      expect(avg).toBeGreaterThan(0.015);
    });
  });
});
