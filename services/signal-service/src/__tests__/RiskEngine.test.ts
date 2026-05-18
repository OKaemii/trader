import { describe, it, expect } from "vitest";
import { RiskEngine, TurnoverBudget, OrderRouter } from '../modules/risk/application/RiskEngine.ts';
import { RISK_LIMITS } from '../modules/signals/application/LongOnlyOptimiser.ts';
import { PortfolioConstructor } from '../modules/signals/application/PortfolioConstructor.ts';
import type { RankingInput } from '../modules/signals/application/LongOnlyOptimiser.ts';
import type { FxConverter } from '@trader/shared-portfolio';
import type { Money } from '@trader/shared-types';
import type { Logger } from '@trader/core';
import type { TradingServiceClient, CashResponse, PositionsResponse } from '@trader/contracts';

// Stub logger + TradingServiceClient for RiskEngine fixtures. RiskEngine reads cash via
// the injected TradingServiceClient (was a direct fetch in the pre-contracts version).
const noopLogger: Logger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    trace: () => {}, fatal: () => {}, child: () => noopLogger, level: 'info',
} as unknown as Logger;
function stubTradingClient(cash: CashResponse): TradingServiceClient {
    return {
        getCash:      async () => cash,
        getPositions: async (): Promise<PositionsResponse> => ({ positions: [] }),
    } as unknown as TradingServiceClient;
}

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

// ── RiskEngine NAV: currency-aware sum via sumPositionsGBP ─────────────────────
// Regression guard for the 2026-05-15 FX cleanup. Pre-cleanup, NAV summed
// `currentValueGBP` (a dual-write cache that silently lied on FX-failure) or fell
// back to native `currentValue` scalars across mixed currencies. Now NAV reads
// the canonical `currentValue` Money per position and FX-converts via the injected
// client. A USD-listed position and a GBP-listed position with the same numeric
// amount must contribute *different* GBP totals.

describe('RiskEngine NAV — currency-aware via sumPositionsGBP', () => {
  function makeFx(rateGbpPerUsd = 0.8): FxConverter {
    return {
      async toGBP(m: Money) {
        if (m.currency === 'GBP') return m.amount;
        if (m.currency === 'USD') return m.amount * rateGbpPerUsd;
        throw new Error(`unsupported ${m.currency}`);
      },
    };
  }

  function makeDb(positions: any[]) {
    const positionsCol = {
      find: () => ({ toArray: async () => positions }),
      countDocuments: async () => 0,
      findOne: async () => null,
      updateOne: async () => ({} as any),
      insertOne: async () => ({} as any),
    } as any;
    return {
      collection: (_name: string) => positionsCol,
    } as any;
  }

  function makeRedis() {
    const store = new Map<string, string>();
    return {
      get:    async (k: string) => store.get(k) ?? null,
      set:    async (k: string, v: string) => { store.set(k, v); return 'OK'; },
      del:    async (k: string) => { store.delete(k); return 1; },
      setEx:  async (k: string, _ttl: number, v: string) => { store.set(k, v); return 'OK'; },
    } as any;
  }

  function cashFixture(amountGBP: number): CashResponse {
    return {
      free:  { amount: amountGBP, currency: 'GBP' },
      total: { amount: amountGBP, currency: 'GBP' },
    };
  }

  it('sums GBP + (USD × rate) + cashGBP via injected FxClient', async () => {
    const positions = [
      { ticker: 'VOD_l_EQ',   quantity: 10, currency: 'GBP',
        currentValue: { amount: 1000, currency: 'GBP' } },
      { ticker: 'AAPL_US_EQ', quantity: 5,  currency: 'USD',
        currentValue: { amount: 1000, currency: 'USD' } },
    ];
    const engine = new RiskEngine(
      makeDb(positions), makeRedis(), makeFx(0.8), stubTradingClient(cashFixture(500)), noopLogger,
    );
    const status = await engine.status();
    // 1000 GBP + 1000 USD * 0.8 + 500 cash = 1000 + 800 + 500 = 2300
    expect(status.nav).toBeCloseTo(2300, 4);
  });

  it('degrades to cash-only when FX throws (does not silently substitute native)', async () => {
    const positions = [
      { ticker: 'AAPL_US_EQ', quantity: 5, currency: 'USD',
        currentValue: { amount: 1000, currency: 'USD' } },
    ];
    const throwingFx: FxConverter = { async toGBP() { throw new Error('fx down'); } };
    const engine = new RiskEngine(
      makeDb(positions), makeRedis(), throwingFx, stubTradingClient(cashFixture(500)), noopLogger,
    );
    const status = await engine.status();
    // FX-throw → positionsGBP = 0; NAV is cash-only. Critically, it is NOT 1000
    // (which would be the pre-fix silent native-as-GBP substitution).
    expect(status.nav).toBe(500);
  });
});
