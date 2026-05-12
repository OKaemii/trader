import { describe, it, expect } from 'bun:test';
import { TurnoverBudget, OrderRouter } from '../application/services/RiskEngine.ts';
import { RISK_LIMITS } from '../application/services/LongOnlyOptimiser.ts';
import { PortfolioConstructor } from '../application/services/PortfolioConstructor.ts';
import type { RankingInput } from '../application/services/LongOnlyOptimiser.ts';

// ── RISK_LIMITS — hard-limit values pinned as regression guards ───────────────
describe('RISK_LIMITS hard limits', () => {
  it('volatilityTarget is 10%', () => {
    expect(RISK_LIMITS.volatilityTarget).toBe(0.10);
  });

  it('maxDailyLoss is 3% (halt threshold)', () => {
    expect(RISK_LIMITS.maxDailyLoss).toBe(0.03);
  });

  it('maxDrawdownHalt is 10% from HWM', () => {
    expect(RISK_LIMITS.maxDrawdownHalt).toBe(0.10);
  });

  it('maxSingleName is 15%', () => {
    expect(RISK_LIMITS.maxSingleName).toBe(0.15);
  });

  it('maxSectorConcentration is 30%', () => {
    expect(RISK_LIMITS.maxSectorConcentration).toBe(0.30);
  });

  it('maxWeeklyTurnover is 20%', () => {
    expect(RISK_LIMITS.maxWeeklyTurnover).toBe(0.20);
  });

  it('minConfidence is 30%', () => {
    expect(RISK_LIMITS.minConfidence).toBe(0.30);
  });

  it('confidenceStaleDays is 90', () => {
    expect(RISK_LIMITS.confidenceStaleDays).toBe(90);
  });
});

// ── TurnoverBudget ─────────────────────────────────────────────────────────────
describe('TurnoverBudget', () => {
  it('returns blend factor 1.0 when turnover is within budget', () => {
    const tb = new TurnoverBudget(0.20);
    expect(tb.computeBlendFactor(0.10)).toBe(1.0);
    expect(tb.computeBlendFactor(0.20)).toBe(1.0);
  });

  it('scales blend factor proportionally when turnover exceeds budget', () => {
    const tb = new TurnoverBudget(0.20);
    expect(tb.computeBlendFactor(0.40)).toBeCloseTo(0.5);
    expect(tb.computeBlendFactor(1.0)).toBeCloseTo(0.20);
  });

  it('uses RISK_LIMITS.maxWeeklyTurnover as default', () => {
    const tb = new TurnoverBudget();
    expect(tb.weeklyLimit).toBe(RISK_LIMITS.maxWeeklyTurnover);
  });
});

// ── OrderRouter ────────────────────────────────────────────────────────────────
describe('OrderRouter', () => {
  it('signals use limit orders (price-preserving)', () => {
    expect(OrderRouter.signalOrderType()).toBe('limit');
  });

  it('risk exits use market orders (immediate execution)', () => {
    expect(OrderRouter.riskExitOrderType()).toBe('market');
  });
});

// ── PortfolioConstructor stability guards ─────────────────────────────────────
describe('PortfolioConstructor stability guards', () => {
  const baseInput = (): RankingInput => ({
    scores: [0.6, 0.4, 0.3],
    tickers: ['AAPL', 'MSFT', 'GOOG'],
    sectors: ['Technology', 'Technology', 'Communication'],
    currentWeights: [0.33, 0.33, 0.34],
    targetVol: 0.10,
    covariance: [[1, 0.3, 0.2], [0.3, 1, 0.25], [0.2, 0.25, 1]],
  });

  const baseAttributions = {
    AAPL: { momentum: 0.5, reversal: 0.1, low_vol: 0.05, topology: 0.05, residual_alpha: 0.1 },
    MSFT: { momentum: 0.3, reversal: 0.05, low_vol: 0.03, topology: 0.02, residual_alpha: 0.05 },
    GOOG: { momentum: 0.2, reversal: 0.05, low_vol: 0.02, topology: 0.01, residual_alpha: 0.03 },
  };

  it('produces no stability warnings for well-conditioned input on first call', () => {
    const pc = new PortfolioConstructor();
    const result = pc.construct(baseInput(), baseAttributions);
    expect(result.stabilityWarnings).toHaveLength(0);
    expect(result.uncertainty).toBe('low');
  });

  it('emits condition number warning for ill-conditioned covariance', () => {
    const pc = new PortfolioConstructor();
    const badCov = [
      [1e6, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const result = pc.construct({ ...baseInput(), covariance: badCov }, baseAttributions);
    expect(result.stabilityWarnings.some((w) => w.includes('condition number'))).toBe(true);
    expect(result.uncertainty).toBe('high');
  });

  it('emits weight change warning on large single-step reallocation', () => {
    const pc = new PortfolioConstructor();
    // First call establishes baseline weights
    pc.construct(baseInput(), baseAttributions);
    // Second call: concentrate everything in AAPL → large weight jump
    const shifted: RankingInput = {
      ...baseInput(),
      scores: [0.99, 0.01, 0.0],
      currentWeights: [0.33, 0.33, 0.34],  // same starting point for blending calc
    };
    const result = pc.construct(shifted, baseAttributions);
    expect(result.stabilityWarnings.some((w) => w.includes('weight step'))).toBe(true);
    expect(result.uncertainty).toBe('high');
  });

  it('computes factor exposures as weighted sum across all required factors', () => {
    const pc = new PortfolioConstructor();
    const result = pc.construct(baseInput(), baseAttributions);
    const expectedFactors = ['momentum', 'reversal', 'low_vol', 'topology', 'residual_alpha'];
    for (const factor of expectedFactors) {
      expect(typeof result.factorExposures[factor]).toBe('number');
    }
    // With positive scores, momentum exposure must be positive
    expect(result.factorExposures['momentum']).toBeGreaterThan(0);
  });

  it('weights are non-negative and sum ≤ 1 (long-only invariant)', () => {
    const pc = new PortfolioConstructor();
    const result = pc.construct(baseInput(), baseAttributions);
    for (const w of result.weights) {
      expect(w).toBeGreaterThanOrEqual(0);
    }
    expect(result.weights.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1 + 1e-9);
  });
});
