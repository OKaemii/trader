// Task 16a — positions are written on the bare (symbol, market) identity. trading-service still hands
// position sync the concatenated T212 ticker over the contract (its broker boundary is Task 17), so
// the sync splits it at the boundary. These tests lock the storage-facing behaviour:
//   - each held position is upserted by { symbol, market } (not by ticker), carrying symbol+market;
//   - the same symbol on two markets writes two distinct rows;
//   - the stale-position cleanup keeps only the held (symbol, market) identities via $nor;
//   - an un-routable T212 ticker is skipped fail-soft (never aborts the sync, never an unkeyed row).

import { describe, it, expect, vi } from 'vitest';
import { PositionSyncService } from '../modules/positions/application/PositionSyncService.ts';
import type { Money } from '@trader/shared-types';

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

// Capture updateOne filters/updates + the deleteMany filter against a fake positions collection.
function fakeDb() {
  const upserts: Array<{ filter: any; update: any }> = [];
  const deletes: any[] = [];
  const coll = {
    updateOne: vi.fn(async (filter: any, update: any) => { upserts.push({ filter, update }); return {}; }),
    deleteMany: vi.fn(async (filter: any) => { deletes.push(filter); return { deletedCount: 0 }; }),
  };
  const db = { collection: () => coll } as any;
  return { db, upserts, deletes };
}

const usd = (amount: number): Money => ({ amount, currency: 'USD' });
const gbp = (amount: number): Money => ({ amount, currency: 'GBP' });

// Identity FX: GBP passthrough, USD * 0.8. Mirrors the existing sync.test FX stub.
const fx = {
  async toGBP(m: Money) { return m.currency === 'GBP' ? m.amount : m.amount * 0.8; },
} as any;

function tradingStub(positions: Array<{ ticker: string; quantity: number; currentPrice: Money; averagePrice?: Money }>) {
  return {
    getPositions: async () => ({ positions }),
    getCash: async () => ({ free: gbp(0), total: gbp(0) }),
  } as any;
}

describe('PositionSyncService — (symbol, market) storage shape', () => {
  it('upserts each held position by { symbol, market }, carrying symbol+market on $set', async () => {
    const { db, upserts } = fakeDb();
    const trading = tradingStub([
      { ticker: 'AAPL_US_EQ', quantity: 10, currentPrice: usd(200), averagePrice: usd(180) },
      { ticker: 'SHELl_EQ',   quantity: 5,  currentPrice: gbp(28) },
    ]);
    await new PositionSyncService({ db, fx, trading, logger }).run();

    const byId = new Map(upserts.map((u) => [`${u.filter.symbol}:${u.filter.market}`, u]));
    expect(byId.has('AAPL:US')).toBe(true);
    expect(byId.has('SHEL:LSE')).toBe(true);
    const aapl = byId.get('AAPL:US')!;
    expect(aapl.filter).toEqual({ symbol: 'AAPL', market: 'US' });
    expect(aapl.update.$set).toMatchObject({ symbol: 'AAPL', market: 'US' });
    expect('ticker' in aapl.update.$set).toBe(false);
    // legacy concatenated-ticker field is cleared so a pre-Thread-A row self-heals
    expect(aapl.update.$unset.ticker).toBe('');
  });

  it('writes two distinct rows for the same symbol on different markets', async () => {
    const { db, upserts } = fakeDb();
    const trading = tradingStub([
      { ticker: 'VOD_US_EQ', quantity: 1, currentPrice: usd(10) },
      { ticker: 'VODl_EQ',   quantity: 1, currentPrice: gbp(8) },
    ]);
    await new PositionSyncService({ db, fx, trading, logger }).run();
    const filters = upserts.map((u) => `${u.filter.symbol}:${u.filter.market}`).sort();
    expect(filters).toEqual(['VOD:LSE', 'VOD:US']);
  });

  it('cleans up stale positions by keeping only the held (symbol, market) identities ($nor)', async () => {
    const { db, deletes } = fakeDb();
    const trading = tradingStub([
      { ticker: 'AAPL_US_EQ', quantity: 10, currentPrice: usd(200) },
      { ticker: 'SHELl_EQ',   quantity: 5,  currentPrice: gbp(28) },
    ]);
    await new PositionSyncService({ db, fx, trading, logger }).run();
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toEqual({ $nor: [{ symbol: 'AAPL', market: 'US' }, { symbol: 'SHEL', market: 'LSE' }] });
  });

  it('deletes ALL positions when T212 reports none (empty held set, matching old $nin:[])', async () => {
    const { db, deletes, upserts } = fakeDb();
    await new PositionSyncService({ db, fx, trading: tradingStub([]), logger }).run();
    expect(upserts).toHaveLength(0);
    expect(deletes[0]).toEqual({});   // match-all delete
  });

  it('skips an un-routable T212 ticker fail-soft (no upsert, not in the held set)', async () => {
    const { db, upserts, deletes } = fakeDb();
    const trading = tradingStub([
      { ticker: 'AAPL_US_EQ', quantity: 10, currentPrice: usd(200) },
      { ticker: 'WEIRD_CFD',  quantity: 1,  currentPrice: usd(1) },
    ]);
    await new PositionSyncService({ db, fx, trading, logger }).run();
    const filters = upserts.map((u) => `${u.filter.symbol}:${u.filter.market}`);
    expect(filters).toEqual(['AAPL:US']);                       // the CFD was skipped
    expect(deletes[0]).toEqual({ $nor: [{ symbol: 'AAPL', market: 'US' }] });
  });

  it('stores the MARKET-derived currency (Task 17 adapter rule), not the contract price tag', async () => {
    // Money-contract correctness: currency is a pure function of the listing market (US → USD,
    // LSE → GBP) via the adapter. Even if the contract handed a mis-tagged price, the stored
    // currency follows the market. Here the broker ticker says US, so the row is USD.
    const { db, upserts } = fakeDb();
    const trading = tradingStub([
      // currentPrice mis-tagged GBP, but AAPL_US_EQ is a US listing → stored currency must be USD.
      { ticker: 'AAPL_US_EQ', quantity: 2, currentPrice: gbp(150) },
      { ticker: 'SHELl_EQ',   quantity: 4, currentPrice: gbp(28) },
    ]);
    await new PositionSyncService({ db, fx, trading, logger }).run();
    const byId = new Map(upserts.map((u) => [`${u.filter.symbol}:${u.filter.market}`, u]));
    expect(byId.get('AAPL:US')!.update.$set.currency).toBe('USD');     // market-derived
    expect(byId.get('AAPL:US')!.update.$set.currentPrice.currency).toBe('USD');
    expect(byId.get('SHEL:LSE')!.update.$set.currency).toBe('GBP');
  });
});
