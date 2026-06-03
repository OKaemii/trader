import { describe, it, expect } from 'vitest';
import type { Logger } from '@trader/core';
import { RiskLimitsProvider } from '../modules/risk/infrastructure/RiskLimitsProvider.ts';
import { RISK_LIMITS } from '../modules/signals/application/LongOnlyOptimiser.ts';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  trace: () => {}, fatal: () => {}, child: () => noopLogger, level: 'info',
} as unknown as Logger;

// Minimal Mongo Db stub: one singleton doc, with find/update call counters so the cache + the
// write path can be asserted without a real Mongo.
function stubDb(initialDoc: Record<string, unknown> | null = null) {
  const calls = { find: 0, update: 0 };
  let stored = initialDoc;
  const db = {
    calls,
    collection: () => ({
      findOne: async () => { calls.find++; return stored; },
      updateOne: async (_filter: unknown, update: { $set: Record<string, unknown> }) => {
        calls.update++;
        stored = { _id: 'singleton', ...update.$set };
        return { acknowledged: true };
      },
    }),
  };
  return db;
}

describe('RiskLimitsProvider', () => {
  it('returns the RISK_LIMITS defaults when no override doc exists', async () => {
    const db = stubDb(null);
    const eff = await new RiskLimitsProvider(db as never, noopLogger).effective();
    expect(eff.maxDailyLoss).toBe(RISK_LIMITS.maxDailyLoss);
    expect(eff.maxSingleName).toBe(RISK_LIMITS.maxSingleName);
    expect(eff.maxWeeklyTurnover).toBe(RISK_LIMITS.maxWeeklyTurnover);
  });

  it('overlays valid stored overrides onto the defaults (each field independent)', async () => {
    const db = stubDb({ _id: 'singleton', overrides: { maxDailyLoss: 0.05, maxSingleName: 0.25 } });
    const eff = await new RiskLimitsProvider(db as never, noopLogger).effective();
    expect(eff.maxDailyLoss).toBe(0.05);            // overridden
    expect(eff.maxSingleName).toBe(0.25);           // overridden
    expect(eff.maxDrawdownHalt).toBe(RISK_LIMITS.maxDrawdownHalt);   // untouched → default
  });

  it('drops out-of-bounds and non-numeric override fields (prior default stands)', async () => {
    const db = stubDb({
      _id: 'singleton',
      overrides: { maxDailyLoss: 5, maxSingleName: -1, maxWeeklyTurnover: 0.5, bogus: 1 },
    });
    const eff = await new RiskLimitsProvider(db as never, noopLogger).effective();
    expect(eff.maxDailyLoss).toBe(RISK_LIMITS.maxDailyLoss);       // 5 > 0.50 bound → dropped
    expect(eff.maxSingleName).toBe(RISK_LIMITS.maxSingleName);     // -1 below bound → dropped
    expect(eff.maxWeeklyTurnover).toBe(0.5);                       // within [0.01, 5] → kept
  });

  it('caches for the TTL window — a second effective() does not re-read Mongo', async () => {
    const db = stubDb(null);
    const p = new RiskLimitsProvider(db as never, noopLogger);
    await p.effective();
    await p.effective();
    expect(db.calls.find).toBe(1);
  });

  it('invalidate() forces the next effective() to re-read', async () => {
    const db = stubDb(null);
    const p = new RiskLimitsProvider(db as never, noopLogger);
    await p.effective();
    p.invalidate();
    await p.effective();
    expect(db.calls.find).toBe(2);
  });

  it('setOverrides persists the sanitised set, returns new effective, and drops the cache', async () => {
    const db = stubDb(null);
    const p = new RiskLimitsProvider(db as never, noopLogger);
    await p.effective();                                  // prime the cache
    const { effective, overrides } = await p.setOverrides({ maxDailyLoss: 0.04, maxDrawdownHalt: 99 });
    expect(overrides).toEqual({ maxDailyLoss: 0.04 });    // 99 out of bounds → dropped
    expect(effective.maxDailyLoss).toBe(0.04);
    expect(db.calls.update).toBe(1);
    // Cache was invalidated by the write → the next read reflects the persisted doc.
    const eff2 = await p.effective();
    expect(eff2.maxDailyLoss).toBe(0.04);
  });

  it('defaults() exposes the compile-time defaults + tunable field list for the editor', () => {
    const meta = new RiskLimitsProvider(stubDb() as never, noopLogger).defaults();
    expect(meta.defaults.maxDailyLoss).toBe(RISK_LIMITS.maxDailyLoss);
    expect(meta.tunableFields).toContain('maxDailyLoss');
    expect(meta.tunableFields).toContain('maxWeeklyTurnover');
    expect(meta.tunableFields).not.toContain('confidenceStaleDays');   // structural, not tunable
  });
});
