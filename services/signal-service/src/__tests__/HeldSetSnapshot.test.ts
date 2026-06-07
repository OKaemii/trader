import { describe, it, expect } from 'vitest';
import { buildHeldSetSnapshots, type HeldSetSnapshotInput } from '../modules/signals/application/HeldSetSnapshot.ts';

const MS_PER_DAY = 86_400_000;
const NOW = 1_717_718_400_000; // fixed "now" so holding-age assertions are deterministic

// Base input: three names ranked by composite score (AAPL > MSFT > GOOG), AAPL + MSFT selected,
// GOOG dropped (weight 0). Holding ages supplied for the two held names.
function baseInput(): HeldSetSnapshotInput {
  return {
    strategyId:    'factor_rank_v1',
    observationTs: NOW,
    tickers:       ['AAPL', 'MSFT', 'GOOG'],
    weights:       [0.06, 0.04, 0],
    scores:        [0.8, 0.5, 0.3],
    oldestOpenBuyAtByTicker: {
      AAPL: NOW - 61 * MS_PER_DAY,
      MSFT: NOW - 10 * MS_PER_DAY,
    },
  };
}

describe('buildHeldSetSnapshots', () => {
  it('writes one doc per universe name, preserving input order', () => {
    const docs = buildHeldSetSnapshots(baseInput(), NOW);
    expect(docs.map((d) => d.ticker)).toEqual(['AAPL', 'MSFT', 'GOOG']);
  });

  it('stamps strategy_id and observation_ts from the cycle on every doc', () => {
    const docs = buildHeldSetSnapshots(baseInput(), NOW);
    for (const d of docs) {
      expect(d.strategy_id).toBe('factor_rank_v1');
      expect(d.observation_ts).toBe(NOW);
    }
  });

  it('ranks by composite score descending — rank 1 is the highest score', () => {
    const docs = buildHeldSetSnapshots(baseInput(), NOW);
    const rankByTicker = Object.fromEntries(docs.map((d) => [d.ticker, d.rank]));
    expect(rankByTicker.AAPL).toBe(1);
    expect(rankByTicker.MSFT).toBe(2);
    expect(rankByTicker.GOOG).toBe(3);
  });

  it('ranks independently of input order (sort, not array position)', () => {
    // Same scores, but the highest-scoring name (GOOG=0.9) is listed last in the universe.
    const input: HeldSetSnapshotInput = {
      ...baseInput(),
      tickers: ['AAPL', 'MSFT', 'GOOG'],
      scores:  [0.5, 0.7, 0.9],
      weights: [0.03, 0.04, 0.05],
      oldestOpenBuyAtByTicker: {},
    };
    const docs = buildHeldSetSnapshots(input, NOW);
    const rankByTicker = Object.fromEntries(docs.map((d) => [d.ticker, d.rank]));
    expect(rankByTicker.GOOG).toBe(1);
    expect(rankByTicker.MSFT).toBe(2);
    expect(rankByTicker.AAPL).toBe(3);
  });

  it('breaks score ties by ticker so ranks are stable and contiguous', () => {
    const input: HeldSetSnapshotInput = {
      ...baseInput(),
      tickers: ['MSFT', 'AAPL', 'GOOG'],
      scores:  [0.5, 0.5, 0.5],
      weights: [0.03, 0.03, 0.03],
      oldestOpenBuyAtByTicker: {},
    };
    const docs = buildHeldSetSnapshots(input, NOW);
    const rankByTicker = Object.fromEntries(docs.map((d) => [d.ticker, d.rank]));
    // Alphabetical tie-break: AAPL < GOOG < MSFT.
    expect(rankByTicker.AAPL).toBe(1);
    expect(rankByTicker.GOOG).toBe(2);
    expect(rankByTicker.MSFT).toBe(3);
    expect([...new Set(docs.map((d) => d.rank))].sort()).toEqual([1, 2, 3]);
  });

  it('selected is true exactly when the final weight is positive', () => {
    const docs = buildHeldSetSnapshots(baseInput(), NOW);
    const byTicker = Object.fromEntries(docs.map((d) => [d.ticker, d]));
    expect(byTicker.AAPL.selected).toBe(true);
    expect(byTicker.MSFT.selected).toBe(true);
    expect(byTicker.GOOG.selected).toBe(false);
  });

  it('reports the optimiser weight for selected names and 0 for unselected', () => {
    const docs = buildHeldSetSnapshots(baseInput(), NOW);
    const byTicker = Object.fromEntries(docs.map((d) => [d.ticker, d]));
    expect(byTicker.AAPL.weight).toBe(0.06);
    expect(byTicker.MSFT.weight).toBe(0.04);
    expect(byTicker.GOOG.weight).toBe(0);
  });

  it('a high score trimmed out of the held set is selected:false with weight 0 (rank survives)', () => {
    // GOOG has the top score but the optimiser zeroed its weight (e.g. top-K / sector cap trim).
    const input: HeldSetSnapshotInput = {
      ...baseInput(),
      tickers: ['AAPL', 'MSFT', 'GOOG'],
      scores:  [0.4, 0.3, 0.9],
      weights: [0.05, 0.05, 0],
      oldestOpenBuyAtByTicker: {},
    };
    const docs = buildHeldSetSnapshots(input, NOW);
    const goog = docs.find((d) => d.ticker === 'GOOG');
    expect(goog?.rank).toBe(1);        // still ranked #1 by score
    expect(goog?.selected).toBe(false); // but not in the held set
    expect(goog?.weight).toBe(0);
  });

  it('treats sub-epsilon (floating-point dust) weights as not selected', () => {
    const input: HeldSetSnapshotInput = {
      ...baseInput(),
      tickers: ['AAPL', 'MSFT', 'GOOG'],
      scores:  [0.8, 0.5, 0.3],
      weights: [0.06, 1e-12, 0],
      oldestOpenBuyAtByTicker: {},
    };
    const docs = buildHeldSetSnapshots(input, NOW);
    const msft = docs.find((d) => d.ticker === 'MSFT');
    expect(msft?.selected).toBe(false);
    expect(msft?.weight).toBe(0);
  });

  it('holding_age_days is whole days since the oldest open BUY', () => {
    const docs = buildHeldSetSnapshots(baseInput(), NOW);
    const byTicker = Object.fromEntries(docs.map((d) => [d.ticker, d]));
    expect(byTicker.AAPL.holding_age_days).toBe(61);
    expect(byTicker.MSFT.holding_age_days).toBe(10);
  });

  it('holding_age_days is 0 when the name has no open BUY', () => {
    const docs = buildHeldSetSnapshots(baseInput(), NOW);
    const goog = docs.find((d) => d.ticker === 'GOOG');
    expect(goog?.holding_age_days).toBe(0);
  });

  it('floors a fractional holding age (a position opened hours ago reads 0 days)', () => {
    const input: HeldSetSnapshotInput = {
      ...baseInput(),
      oldestOpenBuyAtByTicker: { AAPL: NOW - 5 * 3_600_000 }, // 5 hours ago
    };
    const docs = buildHeldSetSnapshots(input, NOW);
    const aapl = docs.find((d) => d.ticker === 'AAPL');
    expect(aapl?.holding_age_days).toBe(0);
  });

  it('a future-dated open BUY (clock skew) clamps holding age to 0, never negative', () => {
    const input: HeldSetSnapshotInput = {
      ...baseInput(),
      oldestOpenBuyAtByTicker: { AAPL: NOW + MS_PER_DAY },
    };
    const docs = buildHeldSetSnapshots(input, NOW);
    const aapl = docs.find((d) => d.ticker === 'AAPL');
    expect(aapl?.holding_age_days).toBe(0);
  });

  it('produces an empty array for an empty universe', () => {
    const input: HeldSetSnapshotInput = {
      ...baseInput(),
      tickers: [],
      weights: [],
      scores:  [],
      oldestOpenBuyAtByTicker: {},
    };
    expect(buildHeldSetSnapshots(input, NOW)).toEqual([]);
  });
});
