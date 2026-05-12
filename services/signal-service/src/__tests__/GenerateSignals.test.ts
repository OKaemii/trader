import { describe, it, expect, beforeEach } from 'bun:test';
import { GenerateSignalsUseCase } from '../application/use-cases/GenerateSignals.ts';
import { TradeSignal } from '../domain/entities/TradeSignal.ts';
import type { ISignalRepository } from '../domain/interfaces/ISignalRepository.ts';
import type { ISignalPublisher } from '../domain/interfaces/ISignalPublisher.ts';
import type { IPortfolioState } from '../domain/interfaces/IPortfolioState.ts';
import type { RiskEngine } from '../application/services/RiskEngine.ts';
import type { StrategyOutput } from '@trader/shared-types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

class MockSignalRepository implements ISignalRepository {
  saved: TradeSignal[] = [];
  async save(s: TradeSignal) { this.saved.push(s); }
  async findById(_id: string) { return null; }
  async findRecent(_limit: number) { return []; }
  async update(_s: TradeSignal) {}
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

  it('saves and publishes every emitted signal', async () => {
    const signals = await useCase.execute(baseFeatures());
    expect(repo.saved).toHaveLength(signals.length);
    expect(publisher.published).toHaveLength(signals.length);
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
});
