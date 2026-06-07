import { describe, it, expect } from 'vitest';
import {
  buildStrategyImpact,
  type StrategyImpactSnapshot,
  type StrategyImpactSignal,
} from '../modules/signals/application/StrategyImpact.ts';
import { SignalLifecycle } from '@trader/shared-types';

// Snapshots are pre-scoped to one ticker (the use-case queries by ticker), so the helper just
// stamps the fields the aggregation reads. observation_ts ascends so "latest" assertions are clear.
function snap(p: Partial<StrategyImpactSnapshot> & { observation_ts: number }): StrategyImpactSnapshot {
  return {
    strategy_id:      'factor_rank_v1',
    ticker:           'AAPL_US_EQ',
    rank:             5,
    selected:         true,
    holding_age_days: 0,
    ...p,
  };
}

function sig(p: Partial<StrategyImpactSignal>): StrategyImpactSignal {
  return {
    strategy_id: 'factor_rank_v1',
    ticker:      'AAPL_US_EQ',
    action:      'BUY',
    lifecycle:   SignalLifecycle.Closed,
    entryPrice:  100,
    exitPrice:   110,
    ...p,
  };
}

describe('buildStrategyImpact', () => {
  it('returns no rows when the ticker was never ranked or traded', () => {
    expect(buildStrategyImpact([], [])).toEqual([]);
  });

  describe('currentRank + selected (latest snapshot wins)', () => {
    it('takes rank and selected from the most recent observation_ts, not insertion order', () => {
      const snaps = [
        snap({ observation_ts: 300, rank: 2,  selected: true }),  // latest
        snap({ observation_ts: 100, rank: 9,  selected: false }),
        snap({ observation_ts: 200, rank: 4,  selected: true }),
      ];
      const [row] = buildStrategyImpact(snaps, []);
      expect(row.currentRank).toBe(2);
      expect(row.selected).toBe(true);
    });

    it('currentRank is null and selected false when the ticker only ever traded (no snapshots)', () => {
      const [row] = buildStrategyImpact([], [sig({})]);
      expect(row.currentRank).toBeNull();
      expect(row.selected).toBe(false);
    });
  });

  describe('historicalInclusionPct', () => {
    it('is the fraction of snapshots with selected=true', () => {
      const snaps = [
        snap({ observation_ts: 1, selected: true }),
        snap({ observation_ts: 2, selected: true }),
        snap({ observation_ts: 3, selected: false }),
        snap({ observation_ts: 4, selected: false }),
      ];
      const [row] = buildStrategyImpact(snaps, []);
      expect(row.historicalInclusionPct).toBeCloseTo(0.5);
    });

    it('is 0 when the ticker was never selected', () => {
      const snaps = [snap({ observation_ts: 1, selected: false }), snap({ observation_ts: 2, selected: false })];
      const [row] = buildStrategyImpact(snaps, []);
      expect(row.historicalInclusionPct).toBe(0);
    });

    it('is 1 when always selected', () => {
      const snaps = [snap({ observation_ts: 1, selected: true }), snap({ observation_ts: 2, selected: true })];
      const [row] = buildStrategyImpact(snaps, []);
      expect(row.historicalInclusionPct).toBe(1);
    });
  });

  describe('avgHoldingDays', () => {
    it('averages holding_age_days only over selected snapshots', () => {
      const snaps = [
        snap({ observation_ts: 1, selected: true,  holding_age_days: 10 }),
        snap({ observation_ts: 2, selected: true,  holding_age_days: 20 }),
        snap({ observation_ts: 3, selected: false, holding_age_days: 0 }), // excluded
      ];
      const [row] = buildStrategyImpact(snaps, []);
      expect(row.avgHoldingDays).toBe(15);
    });

    it('is 0 when the ticker was never selected (avoids a divide-by-zero)', () => {
      const snaps = [snap({ observation_ts: 1, selected: false, holding_age_days: 0 })];
      const [row] = buildStrategyImpact(snaps, []);
      expect(row.avgHoldingDays).toBe(0);
    });
  });

  describe('contributionPct (realised round-trip return)', () => {
    it('sums (exit - entry)/entry over closed BUY round-trips', () => {
      const signals = [
        sig({ entryPrice: 100, exitPrice: 110 }), // +0.10
        sig({ entryPrice: 200, exitPrice: 180 }), // -0.10
      ];
      const [row] = buildStrategyImpact([], signals);
      expect(row.contributionPct).toBeCloseTo(0.0);
    });

    it('counts only closed BUYs — open (executed) BUYs have no realised exit yet', () => {
      const signals = [
        sig({ lifecycle: SignalLifecycle.Closed,   entryPrice: 100, exitPrice: 120 }), // +0.20 realised
        sig({ lifecycle: SignalLifecycle.Executed, entryPrice: 100, exitPrice: undefined }), // open, ignored
      ];
      const [row] = buildStrategyImpact([], signals);
      expect(row.contributionPct).toBeCloseTo(0.2);
    });

    it('excludes SELL legs so an exit is not double-counted against its BUY', () => {
      const signals = [
        sig({ action: 'BUY',  lifecycle: SignalLifecycle.Closed, entryPrice: 100, exitPrice: 130 }), // +0.30
        sig({ action: 'SELL', lifecycle: SignalLifecycle.Closed, entryPrice: 130, exitPrice: 100 }), // ignored
      ];
      const [row] = buildStrategyImpact([], signals);
      expect(row.contributionPct).toBeCloseTo(0.3);
    });

    it('ignores rows with a missing or non-positive entry price', () => {
      const signals = [
        sig({ entryPrice: 0,         exitPrice: 110 }),
        sig({ entryPrice: undefined, exitPrice: 110 }),
        sig({ entryPrice: 100,       exitPrice: undefined }),
      ];
      const [row] = buildStrategyImpact([], signals);
      expect(row.contributionPct).toBe(0);
    });
  });

  describe('per-strategy grouping', () => {
    it('emits one row per strategy, sorted by strategy id, with metrics scoped to that strategy', () => {
      const snaps = [
        snap({ strategy_id: 'factor_rank_v1',     observation_ts: 2, rank: 3, selected: true,  holding_age_days: 40 }),
        snap({ strategy_id: 'factor_rank_v1',     observation_ts: 1, rank: 8, selected: false, holding_age_days: 0 }),
        snap({ strategy_id: 'high_velocity_v1',   observation_ts: 5, rank: 1, selected: true,  holding_age_days: 12 }),
      ];
      const signals = [
        sig({ strategy_id: 'factor_rank_v1',   entryPrice: 100, exitPrice: 110 }), // +0.10
        sig({ strategy_id: 'high_velocity_v1', entryPrice: 100, exitPrice: 90 }),  // -0.10
      ];
      const rows = buildStrategyImpact(snaps, signals);

      expect(rows.map((r) => r.strategyId)).toEqual(['factor_rank_v1', 'high_velocity_v1']);

      const fr = rows.find((r) => r.strategyId === 'factor_rank_v1')!;
      expect(fr.currentRank).toBe(3);             // latest (observation_ts 2)
      expect(fr.selected).toBe(true);
      expect(fr.historicalInclusionPct).toBeCloseTo(0.5); // 1 of 2 selected
      expect(fr.avgHoldingDays).toBe(40);         // only the selected snapshot
      expect(fr.contributionPct).toBeCloseTo(0.1);

      const hv = rows.find((r) => r.strategyId === 'high_velocity_v1')!;
      expect(hv.currentRank).toBe(1);
      expect(hv.contributionPct).toBeCloseTo(-0.1);
    });
  });
});
