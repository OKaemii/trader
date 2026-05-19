// End-to-end scenario: feed a realistic 50-ticker universe through GenerateSignals
// with the new top-K truncation and assert that the emitted signals match the
// intent — buy the top-K, rotate out of demoted holdings, ignore the long tail.
//
// This is the regression guard for the post-2026-05-19 reshape: the strategy used
// to produce ~90 score-proportional weights of ~1% each, which at small NAV got
// quantised down to T212-rejected sub-minimum quantities. Top-K=20 should now
// produce ≤20 BUYs at ~5% target each plus SELLs for held names that fell out.

import { describe, it, expect } from 'vitest';
import { GenerateSignalsUseCase, type GenerateSignalsConfig } from '../modules/signals/application/GenerateSignals.ts';
import { TradeSignal } from '../modules/signals/domain/TradeSignal.ts';
import type { ISignalRepository } from '../modules/signals/domain/ISignalRepository.ts';
import type { ISignalPublisher } from '../modules/signals/domain/ISignalPublisher.ts';
import type { IPortfolioState } from '../modules/risk/application/IPortfolioState.ts';
import type { IPriceLookup } from '../modules/signals/domain/IPriceLookup.ts';
import type { RiskEngine } from '../modules/risk/application/RiskEngine.ts';
import type { StrategyOutput } from '@trader/shared-types';
import type { Logger } from '@trader/core';

const stubLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  trace: () => {}, fatal: () => {}, child: () => stubLogger, level: 'info',
} as unknown as Logger;

const config: GenerateSignalsConfig = { minActionableConfidence: 0.30, volTarget: 0.10 };

class StubRepo implements ISignalRepository {
  saved: TradeSignal[] = [];
  async save(s: TradeSignal) { this.saved.push(s); }
  async findById() { return null; }
  async findRecent() { return []; }
  async approve() {}
  async markExecuted() {}
  async markClosed() {}
  async findOpenBuysByTicker() { return []; }
  async decrementExecutedQuantity() {}
  async setTargetWeight() {}
  async markQueued() {}
  async claimNextQueued() { return null; }
  async requeue() {}
  async markFailed() {}
  async retry() {}
  async sweepStaleExecuting() { return 0; }
  async findByLifecycle() { return []; }   // No in-flight signals — clean slate
}
class StubPublisher implements ISignalPublisher { async publish() {} }
class StubPortfolioState implements IPortfolioState {
  constructor(private w: Record<string, number> = {}) {}
  async currentWeights() { return this.w; }
  async currentDrawdown() { return 0; }
}
class StubPriceLookup implements IPriceLookup {
  constructor(private p: Record<string, number>) {}
  async lastClose(t: string) { return this.p[t] ?? null; }
  async lastCloseMany(ts: string[]) {
    const out: Record<string, number | null> = {};
    for (const t of ts) out[t] = this.p[t] ?? null;
    return out;
  }
}
function stubRiskEngine(): RiskEngine {
  return {
    canTrade: async () => ({ allowed: true, reason: null }),
    applyRegimeScaling: (weights: number[], mult: number) => weights.map((w) => w * mult),
    confidenceDecayFactor: () => 1.0,
  } as unknown as RiskEngine;
}

// Realistic 50-ticker universe with a smooth score gradient from +2.0 down to -2.0.
// Composite scores are z-scores in production; the [-2, +2] band reflects what
// FactorRankStrategy actually produces on a 200-name universe at quiet vol.
function buildScenario(opts: { topK?: number }): {
  features:  StrategyOutput;
  prices:    Record<string, number>;
  tickers:   string[];
} {
  const n = 50;
  const tickers = Array.from({ length: n }, (_, i) => `T${String(i).padStart(2, '0')}_US_EQ`);
  // Linear gradient: T00 is the strongest BUY, T49 the strongest SELL.
  const composite_scores: Record<string, number> = {};
  const sectors: Record<string, string> = {};
  const factor_attributions: Record<string, Record<string, number>> = {};
  // 5 fake sectors round-robin so the sector cap (30%) doesn't bind on top-20.
  const sectorNames = ['Technology', 'Healthcare', 'Financials', 'Energy', 'Consumer'];
  for (let i = 0; i < n; i++) {
    const t = tickers[i]!;
    const score = 2.0 - (4.0 * i) / (n - 1); // 2.0 at i=0, -2.0 at i=n-1
    composite_scores[t] = score;
    sectors[t] = sectorNames[i % sectorNames.length]!;
    factor_attributions[t] = {
      momentum: score * 0.5, reversal: 0.1, low_vol: 0.05, topology: 0,
      residual_alpha: score * 0.3,
    };
  }
  const covariance_matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  // Prices spread $50–$300 — realistic US large-cap range. Used downstream by the
  // dispatcher for sizing; here only relevant for the lastClose lookup.
  const prices: Record<string, number> = {};
  for (let i = 0; i < n; i++) prices[tickers[i]!] = 50 + (250 * i) / (n - 1);

  const features: StrategyOutput = {
    timestamp: Date.now(),
    strategy_id: 'factor_rank_v1',
    ticker_universe: tickers,
    composite_scores,
    factor_attributions,
    sectors,
    covariance_matrix,
    regime_confidence: 0.8,
    position_size_multiplier: 1.0,
    ...(opts.topK !== undefined ? { top_k: opts.topK } : {}),
  };
  return { features, prices, tickers };
}

describe('top-K scenario — empty portfolio', () => {
  it('top-K=20 emits at most 20 BUYs from a 50-name universe', async () => {
    const { features, prices } = buildScenario({ topK: 20 });
    const repo = new StubRepo();
    const useCase = new GenerateSignalsUseCase(
      repo, new StubPublisher(), new StubPortfolioState(),
      stubRiskEngine(), stubLogger, config, undefined, undefined, new StubPriceLookup(prices),
    );
    const signals = await useCase.execute(features);

    const buys  = signals.filter((s) => s.action === 'BUY');
    const sells = signals.filter((s) => s.action === 'SELL');
    expect(sells.length).toBe(0); // no holdings → no exits
    expect(buys.length).toBeLessThanOrEqual(20);
    expect(buys.length).toBeGreaterThan(10); // confidence + score-epsilon may trim a few near-zero
  });

  it('legacy mode (no top_k) emits BUYs across many more names', async () => {
    const { features, prices } = buildScenario({}); // no top_k → full universe weighting
    const repo = new StubRepo();
    const useCase = new GenerateSignalsUseCase(
      repo, new StubPublisher(), new StubPortfolioState(),
      stubRiskEngine(), stubLogger, config, undefined, undefined, new StubPriceLookup(prices),
    );
    const signals = await useCase.execute(features);
    // Without truncation, every positive-score name (24-25 of 50) gets weight,
    // and most clear the per-name 1% emission threshold. This is exactly the
    // over-emission shape the top-K change fixes.
    expect(signals.length).toBeGreaterThan(15);
  });

  it('emitted BUYs target the highest-scoring tickers', async () => {
    const { features, prices, tickers } = buildScenario({ topK: 20 });
    const repo = new StubRepo();
    const useCase = new GenerateSignalsUseCase(
      repo, new StubPublisher(), new StubPortfolioState(),
      stubRiskEngine(), stubLogger, config, undefined, undefined, new StubPriceLookup(prices),
    );
    const signals = await useCase.execute(features);

    // The top 5 (T00–T04) are all positive — they must be in the emission set.
    const emittedTickers = new Set(signals.map((s) => s.ticker));
    for (let i = 0; i < 5; i++) expect(emittedTickers.has(tickers[i]!)).toBe(true);

    // None of the worst 5 (T45–T49, negative scores) should ever appear.
    for (let i = n() - 5; i < n(); i++) expect(emittedTickers.has(tickers[i]!)).toBe(false);
    function n() { return tickers.length; }
  });
});

describe('top-K scenario — rotation', () => {
  it("emits SELL for held tickers that dropped out of top-K and BUY for fresh names that entered", async () => {
    const { features, prices, tickers } = buildScenario({ topK: 20 });
    // Portfolio is half-old-half-new: holds 5 tickers that are still in top-20
    // (T05–T09) and 5 tickers that have rotated out (T25–T29). On a rebalance
    // we expect SELL on the T25-T29 block (they are now weight=0) and the
    // emission set should otherwise look like the empty-portfolio case.
    const heldWeights: Record<string, number> = {};
    for (let i = 5; i < 10; i++)   heldWeights[tickers[i]!] = 0.05; // still in top-20
    for (let i = 25; i < 30; i++)  heldWeights[tickers[i]!] = 0.05; // rotated out
    const state = new StubPortfolioState(heldWeights);

    const repo = new StubRepo();
    const useCase = new GenerateSignalsUseCase(
      repo, new StubPublisher(), state,
      stubRiskEngine(), stubLogger, config, undefined, undefined, new StubPriceLookup(prices),
    );
    const signals = await useCase.execute(features);

    const sellTickers = new Set(signals.filter((s) => s.action === 'SELL').map((s) => s.ticker));
    // Every demoted holding (T25–T29) must produce a SELL — that's how the freed
    // cash funds the new top-K entries on the next dispatcher cycle.
    for (let i = 25; i < 30; i++) {
      expect(sellTickers.has(tickers[i]!)).toBe(true);
    }
    // None of the still-held top-K names (T05–T09) should produce a SELL.
    for (let i = 5; i < 10; i++) {
      expect(sellTickers.has(tickers[i]!)).toBe(false);
    }
  });
});

describe('per-position weight — small NAV regression', () => {
  // This is the load-bearing assertion for "fixed the ZeroQuantity problem".
  // Pre-top-K, with currentWeights=0 and 50 positive scores, per-position weight
  // landed around 4% / 50 ≈ 0.08% — orders of magnitude below T212 minQuantity at
  // £5000 NAV. With top-K=20, per-position weight is ~5% which gives ~£250 per
  // position — well above per-instrument minima on any $50–$300 ticker.
  it('top-K=20 produces target weights that fund tradeable share counts at £5000 NAV', async () => {
    const { features, prices } = buildScenario({ topK: 20 });
    const repo = new StubRepo();
    const useCase = new GenerateSignalsUseCase(
      repo, new StubPublisher(), new StubPortfolioState(),
      stubRiskEngine(), stubLogger, config, undefined, undefined, new StubPriceLookup(prices),
    );
    const signals = await useCase.execute(features);
    const NAV = 5000;

    // For each BUY signal, the implied position value at target should buy at least
    // ~1 share even on the most expensive $300 ticker (so floor + minQuantity≥0.01
    // do not zero it out). The actual quantity is the dispatcher's job; here we
    // assert the optimiser produced a *usable* target weight.
    for (const s of signals.filter((sig) => sig.action === 'BUY')) {
      const targetValue = s.targetWeight * NAV;
      const price = prices[s.ticker]!;
      const shares = targetValue / price;
      // 0.5 share at $300 price is plenty; in practice top-K=20 + $5k NAV yields
      // ~1-5 shares on most names. The previous score-proportional weighting on
      // a 50-name universe produced shares in the 0.01-0.05 range — exactly the
      // ZeroQuantity bucket from the production failure pattern.
      expect(shares).toBeGreaterThan(0.1);
    }
  });
});
