// Task 16a — held_set_snapshots are stored on the bare (symbol, market) identity. The pure builder
// still emits a T212 `ticker` (callers/tests unchanged); the store is the boundary that splits it
// to symbol+market before insert and creates the per-name index on (strategy_id, symbol, market,
// observation_ts). An un-routable name is dropped from the batch (fail-soft), never persisted unkeyed.

import { describe, it, expect, vi } from 'vitest';
import { MongoHeldSetSnapshotStore } from '../modules/signals/infrastructure/MongoHeldSetSnapshotStore.ts';
import type { HeldSetSnapshotDoc } from '../modules/signals/application/HeldSetSnapshot.ts';

function fakeDb() {
  const inserted: any[] = [];
  const indexes: Array<{ spec: any; opts: any }> = [];
  const coll = {
    insertMany: vi.fn(async (docs: any[]) => { inserted.push(...docs); return { insertedCount: docs.length }; }),
    createIndex: vi.fn(async (spec: any, opts: any) => { indexes.push({ spec, opts }); return 'ok'; }),
  };
  const db = { collection: () => coll } as any;
  return { db, inserted, indexes, coll };
}

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

function doc(ticker: string, overrides: Partial<HeldSetSnapshotDoc> = {}): HeldSetSnapshotDoc {
  return { strategy_id: 'factor_rank_v1', observation_ts: 1000, ticker, rank: 1, selected: true,
    weight: 0.05, holding_age_days: 3, ...overrides };
}

describe('MongoHeldSetSnapshotStore — (symbol, market) storage shape', () => {
  it('persists symbol + market (not the concatenated ticker) for US and LSE names', async () => {
    const { db, inserted } = fakeDb();
    const store = new MongoHeldSetSnapshotStore(db, logger);
    await store.write([doc('AAPL_US_EQ'), doc('SHELl_EQ', { rank: 2 })]);
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({ symbol: 'AAPL', market: 'US', rank: 1 });
    expect(inserted[1]).toMatchObject({ symbol: 'SHEL', market: 'LSE', rank: 2 });
    for (const d of inserted) expect('ticker' in d).toBe(false);
  });

  it('creates the per-name index on (strategy_id, symbol, market, observation_ts)', async () => {
    const { db, indexes } = fakeDb();
    const store = new MongoHeldSetSnapshotStore(db, logger);
    await store.write([doc('AAPL_US_EQ')]);
    const named = indexes.find((i) => i.opts?.name === 'held_strategy_symbol_market_obs');
    expect(named).toBeDefined();
    expect(named!.spec).toEqual({ strategy_id: 1, symbol: 1, market: 1, observation_ts: 1 });
  });

  it('drops an un-routable name from the batch rather than persisting it unkeyed', async () => {
    const { db, inserted } = fakeDb();
    const store = new MongoHeldSetSnapshotStore(db, logger);
    await store.write([doc('AAPL_US_EQ'), doc('BOGUS_CFD', { rank: 2 })]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ symbol: 'AAPL', market: 'US' });
  });
});
