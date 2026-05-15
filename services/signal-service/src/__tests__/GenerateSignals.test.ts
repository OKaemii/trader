import { describe, it, expect, beforeEach } from 'bun:test';
import { GenerateSignalsUseCase } from '../application/use-cases/GenerateSignals.ts';
import { TradeSignal } from '../domain/entities/TradeSignal.ts';
import type { ISignalRepository } from '../domain/interfaces/ISignalRepository.ts';
import type { ISignalPublisher } from '../domain/interfaces/ISignalPublisher.ts';
import type { IPortfolioState } from '../domain/interfaces/IPortfolioState.ts';
import type { IPriceLookup } from '../domain/interfaces/IPriceLookup.ts';
import type { RiskEngine } from '../application/services/RiskEngine.ts';
import { SignalLifecycle, type StrategyOutput } from '@trader/shared-types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

class MockSignalRepository implements ISignalRepository {
  saved: TradeSignal[] = [];
  async save(s: TradeSignal) { this.saved.push(s); }
  async findById(_id: string) { return null; }
  async findRecent(_limit: number) { return []; }
  async approve(_id: string) {}
  async markExecuted(_id: string, _at: number) {}
  async markClosed(_id: string, _at: number, _exitPrice: number) {}
  async findOpenBuysByTicker(_ticker: string) { return []; }
  async decrementExecutedQuantity(_id: string, _by: number) {}
  async setTargetWeight(_id: string, _w: number) {}
  async markQueued(_id: string) {}
  async claimNextQueued() { return null; }
  async requeue(_id: string) {}
  async markFailed() {}
  async retry(_id: string) {}
  async sweepStaleExecuting(_ms: number) { return 0; }
  async findByLifecycle() { return []; }
}

class MockPublisher implements ISignalPublisher {
  published: TradeSignal[] = [];
  async publish(s: TradeSignal) { this.published.push(s); }
}

class MockPortfolioState implements IPortfolioState {
  constructor(private weights: Record<string, number> = {}, private drawdown = 0) {}
  async currentWeights() { return this.weights; }
  async currentDrawdown() { return this.drawdown; }
}

class MockPriceLookup implements IPriceLookup {
  constructor(private prices: Record<string, number | null> = {}) {}
  async lastClose(t: string) { return this.prices[t] ?? null; }
  async lastCloseMany(tickers: string[]) {
    const out: Record<string, number | null> = {};
    for (const t of tickers) out[t] = this.prices[t] ?? null;
    return out;
  }
}

function makeMockRiskEngine(allowed = true): RiskEngine {
  return {
    canTrade: async () => ({ allowed, reason: allowed ? null : 'circuit open' }),
    applyRegimeScaling: (weights: number[], multiplier: number) =>
      weights.map((w) => w * Math.max(0.25, Math.min(1.0, multiplier))),
    confidenceDecayFactor: () => 1.0,
    init: async () => {},
    logRejection: async () => {},
    status: async () => ({} as any),
    recordRetrain: async () => {},
    resetCircuitBreaker: async () => {},
  } as unknown as RiskEngine;
}

const baseFeatures = (): StrategyOutput => ({
  timestamp: Date.now(),
  strategy_id: 'factor_rank_v1',
  ticker_universe: ['AAPL', 'MSFT', 'GOOG'],
  composite_scores: { AAPL: 0.8, MSFT: 0.5, GOOG: 0.3 },
  factor_attributions: {
    AAPL: { momentum: 0.6, reversal: 0.1, low_vol: 0.05, topology: 0.05, residual_alpha: 0.1 },
    MSFT: { momentum: 0.4, reversal: 0.05, low_vol: 0.03, topology: 0.02, residual_alpha: 0.05 },
    GOOG: { momentum: 0.2, reversal: 0.05, low_vol: 0.03, topology: 0.02, residual_alpha: 0.05 },
  },
  sectors: { AAPL: 'Technology', MSFT: 'Technology', GOOG: 'Communication' },
  covariance_matrix: [[1, 0.3, 0.2], [0.3, 1, 0.25], [0.2, 0.25, 1]],
  regime_confidence: 0.8,
  position_size_multiplier: 1.0,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GenerateSignalsUseCase', () => {
  let repo: MockSignalRepository;
  let publisher: MockPublisher;
  let portfolioState: MockPortfolioState;
  let useCase: GenerateSignalsUseCase;

  beforeEach(() => {
    repo = new MockSignalRepository();
    publisher = new MockPublisher();
    portfolioState = new MockPortfolioState();
    useCase = new GenerateSignalsUseCase(repo, publisher, portfolioState, makeMockRiskEngine());
  });

  it('emits BUY signals when portfolio is empty and scores are positive', async () => {
    const signals = await useCase.execute(baseFeatures());
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.action === 'BUY')).toBe(true);
  });

  it('saves every emitted signal; publish is deferred to executed transition (policy b)', async () => {
    // Emails now fire only on lifecycle='executed' (via the internal-router /executed
    // callback), not at emission. GenerateSignals saves to Mongo and stops — the
    // publisher is no longer called here. signal-service/internal/trading/signals/:id/executed
    // owns the publish-to-TRADE_SIGNALS hop.
    const signals = await useCase.execute(baseFeatures());
    expect(repo.saved).toHaveLength(signals.length);
    expect(publisher.published).toHaveLength(0);
  });

  it('all targetWeights are in [0, 1] — long-only invariant', async () => {
    const signals = await useCase.execute(baseFeatures());
    for (const s of signals) {
      expect(s.targetWeight).toBeGreaterThanOrEqual(0);
      expect(s.targetWeight).toBeLessThanOrEqual(1);
    }
  });

  it('each signal rationale parses to SignalRationale with plain_english + factor_exposures', async () => {
    const signals = await useCase.execute(baseFeatures());
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      const rationale = JSON.parse(s.rationale);
      expect(typeof rationale.plain_english).toBe('string');
      expect(rationale.plain_english.length).toBeGreaterThan(0);
      expect(typeof rationale.factor_exposures).toBe('object');
      expect(rationale.factor_exposures).not.toBeNull();
    }
  });

  it('returns empty array when circuit breaker is open', async () => {
    const blockedUseCase = new GenerateSignalsUseCase(
      repo, publisher, portfolioState, makeMockRiskEngine(false),
    );
    const signals = await blockedUseCase.execute(baseFeatures());
    expect(signals).toHaveLength(0);
    expect(repo.saved).toHaveLength(0);
    expect(publisher.published).toHaveLength(0);
  });

  it('emits SELL signals when portfolio holds positions that should be exited', async () => {
    // Portfolio holds heavy AAPL; AAPL score is negative → weight → 0 → SELL.
    // Negative composite score gives |score|/0.05 = 0.3/0.05 = 6 → confidence clamped to 1 ≥ threshold.
    const heavyAAPL = new MockPortfolioState({ AAPL: 0.9, MSFT: 0.05, GOOG: 0.05 });
    const features = baseFeatures();
    features.composite_scores = { AAPL: -0.3, MSFT: 0.9, GOOG: 0.1 };
    const sellUseCase = new GenerateSignalsUseCase(repo, publisher, heavyAAPL, makeMockRiskEngine());
    const signals = await sellUseCase.execute(features);
    const hasSell = signals.some((s) => s.action === 'SELL');
    expect(hasSell).toBe(true);
  });

  it('confidence is clamped to [0, 1]', async () => {
    const signals = await useCase.execute(baseFeatures());
    for (const s of signals) {
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
    }
  });

  // Regression: previously the confidence formula used a hardcoded 0.05 saturation point,
  // which clamped to 1.0 for every realistic composite score (live scores were ~[-4, 4]).
  // The fix normalises by the cross-sectional p95 of |score|, so confidence spreads across
  // [0, 1] instead of being uniformly 1.0.
  it('confidence spreads across [0, 1] under realistic score magnitudes', async () => {
    const features = baseFeatures();
    // Three tickers with distinctly different conviction. The top score should saturate
    // (it equals p95 in this 3-element distribution); the bottom should be well under 1.0.
    // Pick magnitudes such that after p95 normalisation, ratios land above the
    // MIN_ACTIONABLE_CONFIDENCE threshold (default 0.3) so multiple signals survive.
    features.composite_scores = { AAPL: 4.0, MSFT: 3.0, GOOG: 1.5 };
    // Ensure all three tickers produce a signal regardless of weight thresholds by giving
    // them disjoint weight targets via the score sign + magnitude.
    const signals = await useCase.execute(features);

    // The set of confidences should NOT all be 1.0 — at least one should be < 1.
    const confidences = signals.map((s) => s.confidence);
    expect(confidences.length).toBeGreaterThan(0);
    expect(Math.min(...confidences)).toBeLessThan(1);

    // The signal for the highest-conviction ticker (AAPL: 4.0) should be at or near the cap,
    // while the lowest (GOOG: 0.1) should be well below.
    const byTicker = Object.fromEntries(signals.map((s) => [s.ticker, s.confidence]));
    if (byTicker.AAPL !== undefined && byTicker.GOOG !== undefined) {
      expect(byTicker.AAPL).toBeGreaterThan(byTicker.GOOG);
    }
  });

  it('confidence is well-defined when all composite scores are zero', async () => {
    const features = baseFeatures();
    features.composite_scores = { AAPL: 0, MSFT: 0, GOOG: 0 };
    // Empty p95 path → divisor falls back to 1.0; |score|=0 → confidence = 0. No signals
    // make it past MIN_ACTIONABLE_CONFIDENCE, but the call must not throw.
    const signals = await useCase.execute(features);
    expect(signals).toHaveLength(0);
  });

  it('stamps entryPrice from the price lookup when available', async () => {
    const prices = new MockPriceLookup({ AAPL: 200, MSFT: 400, GOOG: 150 });
    const withPrices = new GenerateSignalsUseCase(
      repo, publisher, portfolioState, makeMockRiskEngine(),
      undefined, undefined, prices,
    );
    const signals = await withPrices.execute(baseFeatures());
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      // Either the ticker had a price (entryPrice set) or it didn't (undefined).
      // Never zero, never NaN.
      if (s.entryPrice !== undefined) {
        expect(s.entryPrice).toBeGreaterThan(0);
      }
    }
    // At least one signal in the emitted set should have been stamped.
    expect(signals.some((s) => s.entryPrice !== undefined)).toBe(true);
  });

  it('leaves entryPrice undefined when no price is available', async () => {
    const prices = new MockPriceLookup({}); // empty
    const noPrices = new GenerateSignalsUseCase(
      repo, publisher, portfolioState, makeMockRiskEngine(),
      undefined, undefined, prices,
    );
    const signals = await noPrices.execute(baseFeatures());
    for (const s of signals) expect(s.entryPrice).toBeUndefined();
  });

  it('emitted signals start with lifecycle="pending"', async () => {
    const signals = await useCase.execute(baseFeatures());
    for (const s of signals) expect(s.lifecycle).toBe(SignalLifecycle.Pending);
  });
});

describe('TradeSignal.pnlPct', () => {
  const make = (action: 'BUY' | 'SELL', entry?: number) =>
    new TradeSignal({
      id: 'x', timestamp: 0, ticker: 'AAPL', strategy_id: 's',
      action, confidence: 0.5, targetWeight: 0.1, rationale: '{}',
      entryPrice: entry,
    });

  it('BUY: positive return when price rises', () => {
    expect(make('BUY', 100).pnlPct(110)).toBeCloseTo(0.1);
  });
  it('BUY: negative return when price falls', () => {
    expect(make('BUY', 100).pnlPct(90)).toBeCloseTo(-0.1);
  });
  it('SELL: inverts sign — profit when price falls', () => {
    expect(make('SELL', 100).pnlPct(90)).toBeCloseTo(0.1);
  });
  it('null entryPrice → null pnl', () => {
    expect(make('BUY').pnlPct(110)).toBeNull();
  });
  it('null currentPrice → null pnl', () => {
    expect(make('BUY', 100).pnlPct(null)).toBeNull();
  });
  it('non-positive currentPrice → null pnl', () => {
    expect(make('BUY', 100).pnlPct(0)).toBeNull();
  });
});
