import { describe, it, expect } from 'vitest';
import { toSignalDoc, fromSignalDoc } from '../shared/data.ts';
import { TradeSignal, SignalLifecycle } from '../modules/signals/domain/TradeSignal.ts';
import type { StrategyOutput } from '@trader/shared-types';

const makeAnalysisContext = (ticker: string, score: number): StrategyOutput => ({
  timestamp:                Date.UTC(2026, 4, 18, 14, 30),
  strategy_id:              'factor_rank_v1',
  ticker_universe:          [],
  composite_scores:         { [ticker]: score },
  factor_attributions:      {},
  sectors:                  { [ticker]: 'Technology' },
  covariance_matrix:        [],
  regime_confidence:        0.72,
  position_size_multiplier: 0.79,
});

function makeSignal(overrides: Partial<ConstructorParameters<typeof TradeSignal>[0]> = {}): TradeSignal {
  return new TradeSignal({
    id: 'sig-1',
    timestamp: Date.UTC(2026, 4, 18, 14, 30),
    ticker: 'AAPL_US_EQ',
    strategy_id: 'factor_rank_v1',
    action: 'BUY',
    confidence: 0.6,
    targetWeight: 0.05,
    rationale: '{}',
    lifecycle: SignalLifecycle.Pending,
    ...overrides,
  });
}

describe('toSignalDoc / fromSignalDoc', () => {
  it('round-trips features_snapshot through the Mongo serialiser', () => {
    const ctx = makeAnalysisContext('AAPL_US_EQ', 0.42);
    const s = makeSignal({ features_snapshot: ctx });

    const doc = toSignalDoc(s);
    expect(doc.features_snapshot).toBeDefined();
    expect(doc.features_snapshot.strategy_id).toBe('factor_rank_v1');
    expect(doc.features_snapshot.composite_scores.AAPL_US_EQ).toBe(0.42);
    expect(doc.features_snapshot.sectors.AAPL_US_EQ).toBe('Technology');
    expect(doc.features_snapshot.regime_confidence).toBeCloseTo(0.72);
    expect(doc.features_snapshot.position_size_multiplier).toBeCloseTo(0.79);

    // Simulate Mongo bouncing the doc through BSON: Dates become Date instances
    // (toSignalDoc already wraps them), nested plain objects round-trip as-is.
    const restored = fromSignalDoc(doc);
    expect(restored.features_snapshot).toBeDefined();
    expect(restored.features_snapshot?.strategy_id).toBe('factor_rank_v1');
    expect(restored.features_snapshot?.composite_scores.AAPL_US_EQ).toBe(0.42);
    expect(restored.features_snapshot?.sectors.AAPL_US_EQ).toBe('Technology');
    expect(restored.features_snapshot?.regime_confidence).toBeCloseTo(0.72);
    expect(restored.features_snapshot?.position_size_multiplier).toBeCloseTo(0.79);
  });

  it('leaves features_snapshot undefined for legacy docs missing the field', () => {
    const s = makeSignal();
    const doc = toSignalDoc(s);
    expect(doc.features_snapshot).toBeUndefined();

    // Older Mongo docs literally have no features_snapshot key.
    delete doc.features_snapshot;
    const restored = fromSignalDoc(doc);
    expect(restored.features_snapshot).toBeUndefined();
  });

  it('drops a malformed features_snapshot (non-object) rather than throwing', () => {
    // Defence against partially-migrated rows or hand-edited docs.
    const doc = toSignalDoc(makeSignal());
    doc.features_snapshot = 'not-an-object';
    const restored = fromSignalDoc(doc);
    expect(restored.features_snapshot).toBeUndefined();
  });

  it('round-trips lifecycle, attempts, and timestamps alongside features_snapshot', () => {
    const ctx = makeAnalysisContext('MSFT_US_EQ', -0.31);
    const s = makeSignal({
      ticker: 'MSFT_US_EQ',
      action: 'SELL',
      lifecycle: SignalLifecycle.Queued,
      attempts: 2,
      lastAttemptAt: Date.UTC(2026, 4, 18, 15, 0),
      features_snapshot: ctx,
    });
    const restored = fromSignalDoc(toSignalDoc(s));
    expect(restored.ticker).toBe('MSFT_US_EQ');
    expect(restored.action).toBe('SELL');
    expect(restored.lifecycle).toBe(SignalLifecycle.Queued);
    expect(restored.attempts).toBe(2);
    expect(restored.lastAttemptAt).toBe(Date.UTC(2026, 4, 18, 15, 0));
    expect(restored.features_snapshot?.composite_scores.MSFT_US_EQ).toBe(-0.31);
  });
});
