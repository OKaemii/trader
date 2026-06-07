import { describe, it, expect, beforeEach } from "vitest";
import { GenerateSignalsUseCase, type GenerateSignalsConfig } from '../modules/signals/application/GenerateSignals.ts';
import { TradeSignal } from '../modules/signals/domain/TradeSignal.ts';
import type { ISignalRepository } from '../modules/signals/domain/ISignalRepository.ts';
import type { ISignalPublisher } from '../modules/signals/domain/ISignalPublisher.ts';
import type { IPortfolioState } from '../modules/risk/application/IPortfolioState.ts';
import type { IPriceLookup } from '../modules/signals/domain/IPriceLookup.ts';
import type { RiskEngine } from '../modules/risk/application/RiskEngine.ts';
import type { HeldSetSnapshotDoc, IHeldSetSnapshotStore } from '../modules/signals/application/HeldSetSnapshot.ts';
import { SignalLifecycle, type StrategyOutput } from '@trader/shared-types';
import type { Logger } from '@trader/core';

const stubLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  trace: () => {}, fatal: () => {}, child: () => stubLogger, level: 'info',
} as unknown as Logger;

const stubConfig: GenerateSignalsConfig = {
  minActionableConfidence: 0.30,
  volTarget: 0.10,
};

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
  async findByTicker() { return []; }
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

class MockHeldSetSnapshotStore implements IHeldSetSnapshotStore {
  written: HeldSetSnapshotDoc[][] = [];
  constructor(private readonly throwOnWrite = false) {}
  async write(docs: HeldSetSnapshotDoc[]) {
    if (this.throwOnWrite) throw new Error('mongo down');
    this.written.push(docs);
  }
}

function makeMockRiskEngine(allowed = true, navGBP = 0): RiskEngine {
  return {
    canTrade: async () => ({ allowed, reason: allowed ? null : 'circuit open' }),
    applyRegimeScaling: (weights: number[], multiplier: number) =>
      weights.map((w) => w * Math.max(0.25, Math.min(1.0, multiplier))),
    confidenceDecayFactor: () => 1.0,
    currentNavGBP: async () => navGBP,
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
    useCase = new GenerateSignalsUseCase(repo, publisher, portfolioState, makeMockRiskEngine(), stubLogger, stubConfig);
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
    const blockedUseCase = new GenerateSignalsUseCase(repo, publisher, portfolioState, makeMockRiskEngine(false), stubLogger, stubConfig);
    const signals = await blockedUseCase.execute(baseFeatures());
    expect(signals).toHaveLength(0);
    expect(repo.saved).toHaveLength(0);
    expect(publisher.published).toHaveLength(0);
  });

  it('skips tickers that already have an in-flight signal (Approved/Queued/Executing)', async () => {
    // Regression: without this filter, the strategy reads currentWeights from Mongo
    // (synced every 5min by portfolio-service) and re-emits a BUY for a ticker whose
    // prior BUY is still in the dispatcher queue. By the time that newer BUY is claimed,
    // the position has filled past target and qty rounds to zero, failing the signal.
    repo.findByLifecycle = async (states) => {
      if (states.includes(SignalLifecycle.Queued)) {
        return [new TradeSignal({
          id: 'inflight-aapl',
          timestamp: Date.now(),
          ticker: 'AAPL',
          strategy_id: 'factor_rank_v1',
          action: 'BUY',
          confidence: 0.8,
          targetWeight: 0.05,
          rationale: '{}',
          lifecycle: SignalLifecycle.Queued,
        })];
      }
      return [];
    };
    const signals = await useCase.execute(baseFeatures());
    expect(signals.every((s) => s.ticker !== 'AAPL')).toBe(true);
  });

  it('emits SELL signals when portfolio holds positions that should be exited', async () => {
    // Portfolio holds heavy AAPL; AAPL score is negative → weight → 0 → SELL.
    // Negative composite score gives |score|/0.05 = 0.3/0.05 = 6 → confidence clamped to 1 ≥ threshold.
    const heavyAAPL = new MockPortfolioState({ AAPL: 0.9, MSFT: 0.05, GOOG: 0.05 });
    const features = baseFeatures();
    features.composite_scores = { AAPL: -0.3, MSFT: 0.9, GOOG: 0.1 };
    const sellUseCase = new GenerateSignalsUseCase(repo, publisher, heavyAAPL, makeMockRiskEngine(), stubLogger, stubConfig);
    const signals = await sellUseCase.execute(features);
    const hasSell = signals.some((s) => s.action === 'SELL');
    expect(hasSell).toBe(true);
  });

  it('liquidates a demoted SUB-1% holding (the legacy-bloat cleanup path)', async () => {
    // Regression: the old symmetric 1% no-trade band stranded every held position below
    // 1% — a name demoted out of top-K with currentW≈0.7% produced HOLD, not SELL, so a
    // bloated book of tiny positions could never be unwound. AAPL held at 0.7%, scored
    // negative so its target weight is 0 → must now emit a SELL despite being sub-1%.
    const tinyAAPL = new MockPortfolioState({ AAPL: 0.007, MSFT: 0.5, GOOG: 0.3 });
    const features = baseFeatures();
    features.composite_scores = { AAPL: -0.3, MSFT: 0.9, GOOG: 0.5 };
    const uc = new GenerateSignalsUseCase(repo, publisher, tinyAAPL, makeMockRiskEngine(), stubLogger, stubConfig);
    const signals = await uc.execute(features);
    const aaplSell = signals.find((s) => s.ticker === 'AAPL' && s.action === 'SELL');
    expect(aaplSell).toBeDefined();
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
  it('confidence spreads across [0, 1] under realistic score magnitudes (p95 path)', async () => {
    // Universe expanded to 6 tickers so the positive cohort exceeds minPositivePeers
    // (default 5) and the p95 path engages — the original 3-ticker version now falls
    // into the sparse-positive fallback (divisor=1.0), which is correct but not what
    // this regression documents.
    const features: StrategyOutput = {
      ...baseFeatures(),
      ticker_universe: ['AAPL', 'MSFT', 'GOOG', 'AMZN', 'META', 'NFLX'],
      composite_scores: { AAPL: 4.0, MSFT: 3.0, GOOG: 1.5, AMZN: 2.5, META: 2.0, NFLX: 0.5 },
      sectors: { AAPL: 'T', MSFT: 'T', GOOG: 'C', AMZN: 'T', META: 'C', NFLX: 'C' },
      factor_attributions: Object.fromEntries(['AAPL','MSFT','GOOG','AMZN','META','NFLX'].map((t) => [
        t, { momentum: 0.5, reversal: 0.1, low_vol: 0.05, topology: 0.05, residual_alpha: 0.1 },
      ])),
      covariance_matrix: Array.from({ length: 6 }, (_, i) =>
        Array.from({ length: 6 }, (_, j) => (i === j ? 1 : 0.2))),
    };
    const signals = await useCase.execute(features);
    const confidences = signals.map((s) => s.confidence);
    expect(confidences.length).toBeGreaterThan(0);
    // At least one confidence is < 1 — p95 spreads the values.
    expect(Math.min(...confidences)).toBeLessThan(1);
    // Top score (AAPL at 4.0) should exceed bottom (NFLX at 0.5).
    const byTicker = Object.fromEntries(signals.map((s) => [s.ticker, s.confidence]));
    if (byTicker.AAPL !== undefined && byTicker.NFLX !== undefined) {
      expect(byTicker.AAPL).toBeGreaterThan(byTicker.NFLX);
    }
  });

  // Regression: production incident 2026-05-15. factor_rank_v1 emitted realistic scores
  // with a small positive long-side tail (top ~+0.2) and a large negative short-side tail
  // (bottom ~−1.75). The pooled-|score| p95 was driven by the bearish tail, so every BUY
  // confidence landed below MIN_ACTIONABLE_CONFIDENCE=0.30 and the entire long book was
  // silently filtered — `db.signals.count() == 0`. Sign-aware normalisation measures each
  // side's conviction against its own dispersion, so a long-side ticker at the +p95 of the
  // positive cohort saturates at 1.0 regardless of how heavy the short tail is.
  it('long-side confidence is not crushed by an asymmetric bearish tail (sign-aware p95)', async () => {
    // 5 positive tickers (meets minPositivePeers) + 1 large negative outlier. Pre-fix
    // (pooled-|score| divisor) the −2.0 tail dominated and crushed every long
    // confidence below MIN_ACTIONABLE_CONFIDENCE. Sign-aware p95 measures each side
    // against its own dispersion, so AAPL at the top of the positive cohort saturates
    // at 1.0 regardless of how heavy the short tail is.
    const features: StrategyOutput = {
      ...baseFeatures(),
      ticker_universe: ['AAPL', 'MSFT', 'GOOG', 'AMZN', 'META', 'NEG'],
      composite_scores: { AAPL: 0.5, MSFT: 0.45, GOOG: 0.4, AMZN: 0.35, META: 0.3, NEG: -2.0 },
      sectors: { AAPL: 'T', MSFT: 'T', GOOG: 'C', AMZN: 'T', META: 'C', NEG: 'C' },
      factor_attributions: Object.fromEntries(['AAPL','MSFT','GOOG','AMZN','META','NEG'].map((t) => [
        t, { momentum: 0.5, reversal: 0.1, low_vol: 0.05, topology: 0.05, residual_alpha: 0.1 },
      ])),
      covariance_matrix: Array.from({ length: 6 }, (_, i) =>
        Array.from({ length: 6 }, (_, j) => (i === j ? 1 : 0.2))),
    };
    const signals = await useCase.execute(features);
    const buys = signals.filter((s) => s.action === 'BUY');
    expect(buys.length).toBeGreaterThan(0);
    const aapl = signals.find((s) => s.ticker === 'AAPL');
    expect(aapl?.confidence).toBeCloseTo(1.0, 5);
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
    const withPrices = new GenerateSignalsUseCase(repo, publisher, portfolioState, makeMockRiskEngine(), stubLogger, stubConfig, undefined, undefined, prices);
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
    const noPrices = new GenerateSignalsUseCase(repo, publisher, portfolioState, makeMockRiskEngine(), stubLogger, stubConfig, undefined, undefined, prices);
    const signals = await noPrices.execute(baseFeatures());
    for (const s of signals) expect(s.entryPrice).toBeUndefined();
  });

  it('emitted signals start with lifecycle="pending"', async () => {
    const signals = await useCase.execute(baseFeatures());
    for (const s of signals) expect(s.lifecycle).toBe(SignalLifecycle.Pending);
  });

  // ── Confidence math — sparse-positive / tiny-score / SELL bypass / normal ──
  //
  // Regression: previously a 1-element positive cohort had p95 = the element itself →
  // ratio = 1 → confidence pinned to 1.0 regardless of how small the score was. The
  // operator saw 100%-confidence BUYs whose displayed score rounded to 0.000.
  // Fix: when posScores.length < minPositivePeers (default 5), divisor falls back to
  // an absolute 1.0; an |score| < minScoreEpsilon (default 0.1) forces confidence to 0.
  //
  // Universe is 3 tickers, well below the default 5-peer threshold, so the fallback
  // path fires in every case below — exactly the production scenario.

  it('singleton-positive cohort: confidence reflects the actual score magnitude, not 1.0', async () => {
    // One positive cohort member, two flat. Pre-fix: p95 = 0.0008 → ratio = 1.
    // Post-fix: divisor = 1.0 (sparse path) → confidence = 0.0008 ≪ 1.0.
    const features = baseFeatures();
    features.composite_scores = { AAPL: 0.0008, MSFT: 0, GOOG: 0 };
    const localConfig: GenerateSignalsConfig = {
      ...stubConfig,
      minActionableConfidence: 0,   // disable the BUY gate so the signal survives
      minScoreEpsilon:         0,   // disable the tiny-score gate for this assertion
    };
    const local = new GenerateSignalsUseCase(repo, publisher, portfolioState, makeMockRiskEngine(), stubLogger, localConfig);
    const signals = await local.execute(features);
    const aapl = signals.find((s) => s.ticker === 'AAPL');
    expect(aapl).toBeDefined();
    expect(aapl!.confidence).toBeLessThan(0.01);
    expect(aapl!.confidence).toBeGreaterThan(0);
  });

  it('tiny-score gate forces confidence=0 and BUY is dropped (MIN_SCORE_EPSILON)', async () => {
    // |score| = 0.05 < 0.1 (default minScoreEpsilon) → confidence forced to 0 →
    // isActionable(minActionableConfidence=0.30) returns false → BUY filtered out.
    const features = baseFeatures();
    features.composite_scores = { AAPL: 0.05, MSFT: 0, GOOG: 0 };
    const signals = await useCase.execute(features);
    expect(signals.find((s) => s.ticker === 'AAPL' && s.action === 'BUY')).toBeUndefined();
  });

  it('tiny-score gate still allows SELLs through (exits are portfolio-driven)', async () => {
    // Same tiny score, but the portfolio holds the position heavily — strategy emits
    // SELL to free capital. Confidence is forced to 0 but the SELL bypasses the
    // confidence floor (see filter rule in GenerateSignals).
    const features = baseFeatures();
    features.composite_scores = { AAPL: -0.05, MSFT: 0.9, GOOG: 0.1 };
    const heavyAAPL = new MockPortfolioState({ AAPL: 0.9, MSFT: 0.05, GOOG: 0.05 });
    const sellUseCase = new GenerateSignalsUseCase(
      repo, publisher, heavyAAPL, makeMockRiskEngine(), stubLogger, stubConfig,
    );
    const signals = await sellUseCase.execute(features);
    const aaplSell = signals.find((s) => s.ticker === 'AAPL' && s.action === 'SELL');
    expect(aaplSell).toBeDefined();
    // Even though confidence is 0 (|score| < epsilon), the SELL is preserved.
    expect(aaplSell!.confidence).toBe(0);
  });

  it('normal cross-section (>= minPositivePeers): p95 normalisation unchanged', async () => {
    // 6 positive tickers — exceeds default minPositivePeers (5) → divisor uses p95,
    // not the absolute fallback. Spread of confidences across [low, 1] is preserved.
    const features: StrategyOutput = {
      ...baseFeatures(),
      ticker_universe: ['A', 'B', 'C', 'D', 'E', 'F'],
      composite_scores: { A: 1.0, B: 0.9, C: 0.7, D: 0.5, E: 0.3, F: 0.2 },
      sectors: { A: 'X', B: 'X', C: 'X', D: 'X', E: 'X', F: 'X' },
      factor_attributions: Object.fromEntries(['A','B','C','D','E','F'].map((t) => [
        t, { momentum: 0.5, reversal: 0.1, low_vol: 0.05, topology: 0.05, residual_alpha: 0.1 },
      ])),
      covariance_matrix: Array.from({ length: 6 }, (_, i) =>
        Array.from({ length: 6 }, (_, j) => (i === j ? 1 : 0.2))),
    };
    const signals = await useCase.execute(features);
    expect(signals.length).toBeGreaterThan(0);
    const confidences = signals.map((s) => s.confidence);
    // p95 path is in play — at least one confidence saturates at 1, at least one is < 1.
    expect(Math.max(...confidences)).toBeCloseTo(1.0, 5);
    expect(Math.min(...confidences)).toBeLessThan(1);
  });

  it('persists features_snapshot onto every emitted signal for downstream notification enrichment', async () => {
    const features = baseFeatures();
    const signals = await useCase.execute(features);
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      expect(s.features_snapshot).toBeDefined();
      expect(s.features_snapshot?.strategy_id).toBe(features.strategy_id);
      // Per-ticker slice: only this signal's score + sector survive the trim.
      expect(s.features_snapshot?.composite_scores[s.ticker]).toBeDefined();
      expect(s.features_snapshot?.sectors[s.ticker]).toBeDefined();
      // Universe + covariance are deliberately stripped to keep the Mongo doc small.
      expect(s.features_snapshot?.ticker_universe).toEqual([]);
      expect(s.features_snapshot?.covariance_matrix).toEqual([]);
      expect(s.features_snapshot?.regime_confidence).toBe(features.regime_confidence);
    }
  });

  it('plumbs report_cadence from StrategyOutput onto the analysisContext on every emitted signal', async () => {
    const features = baseFeatures();
    features.report_cadence = 'hourly';
    const signals = await useCase.execute(features);
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      expect(s.features_snapshot?.report_cadence).toBe('hourly');
    }
  });

  it('omits report_cadence on the analysisContext when the strategy did not declare one', async () => {
    const features = baseFeatures();
    delete (features as { report_cadence?: unknown }).report_cadence;
    const signals = await useCase.execute(features);
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      expect(s.features_snapshot?.report_cadence).toBeUndefined();
    }
  });

  // ── held_set_snapshots writer (Task 11) ───────────────────────────────────────

  it('writes one held_set_snapshot doc per universe name after optimisation', async () => {
    const store = new MockHeldSetSnapshotStore();
    const uc = new GenerateSignalsUseCase(
      repo, publisher, portfolioState, makeMockRiskEngine(), stubLogger, stubConfig,
      undefined, undefined, undefined, undefined, undefined, store,
    );
    const features = baseFeatures();
    await uc.execute(features);
    expect(store.written).toHaveLength(1);
    const docs = store.written[0];
    expect(docs.map((d) => d.ticker).sort()).toEqual([...features.ticker_universe].sort());
    // rank covers 1..N contiguously, AAPL (top score) is rank 1.
    expect(docs.find((d) => d.ticker === 'AAPL')?.rank).toBe(1);
    for (const d of docs) {
      expect(d.strategy_id).toBe(features.strategy_id);
      expect(d.observation_ts).toBe(features.timestamp);
    }
  });

  it('held-set holding_age_days comes from the oldest open BUY of a currently-held name', async () => {
    const store = new MockHeldSetSnapshotStore();
    const held = new MockPortfolioState({ AAPL: 0.5 });
    const fortyDaysAgo = Date.now() - 40 * 86_400_000;
    repo.findOpenBuysByTicker = async (ticker: string) =>
      ticker === 'AAPL'
        ? [new TradeSignal({
            id: 'buy-aapl', timestamp: fortyDaysAgo, ticker: 'AAPL', strategy_id: 'factor_rank_v1',
            action: 'BUY', confidence: 0.8, targetWeight: 0.05, rationale: '{}',
            lifecycle: SignalLifecycle.Executed, executedAt: fortyDaysAgo, executedQuantity: 10,
          })]
        : [];
    const uc = new GenerateSignalsUseCase(
      repo, publisher, held, makeMockRiskEngine(), stubLogger, stubConfig,
      undefined, undefined, undefined, undefined, undefined, store,
    );
    await uc.execute(baseFeatures());
    const aapl = store.written[0].find((d) => d.ticker === 'AAPL');
    expect(aapl?.holding_age_days).toBe(40);
    // Names that aren't held don't trigger an open-BUY lookup → age 0.
    expect(store.written[0].find((d) => d.ticker === 'GOOG')?.holding_age_days).toBe(0);
  });

  it('a snapshot write failure logs but never blocks emission (best-effort contract)', async () => {
    const store = new MockHeldSetSnapshotStore(true); // throws on write
    const uc = new GenerateSignalsUseCase(
      repo, publisher, portfolioState, makeMockRiskEngine(), stubLogger, stubConfig,
      undefined, undefined, undefined, undefined, undefined, store,
    );
    const signals = await uc.execute(baseFeatures());
    expect(signals.length).toBeGreaterThan(0);
    expect(repo.saved).toHaveLength(signals.length);
  });

  it('emits normally when no snapshot store is wired (optional dependency)', async () => {
    const signals = await useCase.execute(baseFeatures());
    expect(signals.length).toBeGreaterThan(0);
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
