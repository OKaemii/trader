// Task 16a — orders are stored + queried on the bare (symbol, market) identity, never the
// concatenated Trading212 ticker. The in-memory Order entity keeps .ticker (the broker call and the
// FillsPoller's cross-service openBuys(ticker) still use the T212 string until Task 17), so the
// repository splits it to symbol+market on write and re-derives it on read. These tests lock:
//   - save() persists symbol+market (no `ticker`) and a round-tripped Order.ticker is byte-identical;
//   - findInflightByTicker (the in-flight netting that prevents double-sizing) keys on (symbol,
//     market) + Submitted status, disambiguates the same symbol across markets, and is fail-soft.

import { describe, it, expect } from 'vitest';
import { MongoOrderRepository } from '../modules/orders/infrastructure/MongoOrderRepository.ts';
import { type Order, OrderSide, OrderType, OrderStatus } from '../modules/orders/domain/Order.ts';

// Minimal in-memory `orders` collection stub honouring the slice the repository uses
// (updateOne upsert by _id, find by symbol/market/status, findOne by _id/signalId).
class MemCollection {
  rows = new Map<string, any>();
  async updateOne(filter: any, update: any, opts: any) {
    const id = filter._id;
    const set = update.$set ?? {};
    const existing = this.rows.get(id);
    if (existing) Object.assign(existing, set);
    else if (opts?.upsert) this.rows.set(id, { ...set });
    return { acknowledged: true };
  }
  async findOne(filter: any) {
    for (const r of this.rows.values()) if (this.matches(r, filter)) return r;
    return null;
  }
  find(filter: any) {
    const list = Array.from(this.rows.values()).filter((r) => this.matches(r, filter));
    return { sort: () => ({ limit: () => ({ toArray: async () => list }) }), toArray: async () => list };
  }
  private matches(row: any, filter: any): boolean {
    return Object.entries(filter).every(([k, v]) => {
      if (v && typeof v === 'object' && '$exists' in (v as any)) return (k in row) === (v as any).$exists;
      return row[k] === v;
    });
  }
}

function fakeDb() {
  const coll = new MemCollection();
  const db = { collection: () => coll } as any;
  return { db, coll };
}

function order(id: string, ticker: string, status: OrderStatus, signalId = `sig-${id}`): Order {
  return { id, ticker, side: OrderSide.Buy, orderType: OrderType.Limit, quantity: 10,
    status, signalId, targetWeight: 0.05, timestamp: Date.UTC(2026, 0, 1) };
}

describe('MongoOrderRepository — (symbol, market) storage shape', () => {
  it('save() persists symbol + market and drops the concatenated ticker', async () => {
    const { db, coll } = fakeDb();
    const repo = new MongoOrderRepository(db);
    await repo.save(order('o1', 'AAPL_US_EQ', OrderStatus.Submitted));
    const doc = coll.rows.get('o1');
    expect(doc.symbol).toBe('AAPL');
    expect(doc.market).toBe('US');
    expect('ticker' in doc).toBe(false);
  });

  it('re-derives Order.ticker from (symbol, market) on read (round-trip both markets)', async () => {
    const { db } = fakeDb();
    const repo = new MongoOrderRepository(db);
    await repo.save(order('us',  'AAPL_US_EQ', OrderStatus.Submitted, 'sig-us'));
    await repo.save(order('lse', 'SHELl_EQ',   OrderStatus.Submitted, 'sig-lse'));
    expect((await repo.findById('us'))?.ticker).toBe('AAPL_US_EQ');
    expect((await repo.findBySignalId('sig-lse'))?.ticker).toBe('SHELl_EQ');
  });

  it('findInflightByTicker keys on (symbol, market) + Submitted, disambiguating markets', async () => {
    const { db } = fakeDb();
    const repo = new MongoOrderRepository(db);
    await repo.save(order('us-sub',    'VOD_US_EQ', OrderStatus.Submitted, 'a'));
    await repo.save(order('lse-sub',   'VODl_EQ',   OrderStatus.Submitted, 'b'));
    await repo.save(order('us-filled', 'VOD_US_EQ', OrderStatus.Filled,    'c'));

    const us = await repo.findInflightByTicker('VOD_US_EQ');
    expect(us.map((o) => o.id)).toEqual(['us-sub']);          // Submitted only, US only
    const lse = await repo.findInflightByTicker('VODl_EQ');
    expect(lse.map((o) => o.id)).toEqual(['lse-sub']);
  });

  it('findInflightByTicker returns [] for an un-routable ticker (fail-soft)', async () => {
    const { db } = fakeDb();
    const repo = new MongoOrderRepository(db);
    await repo.save(order('o1', 'AAPL_US_EQ', OrderStatus.Submitted));
    await expect(repo.findInflightByTicker('AAPL_CFD')).resolves.toEqual([]);
  });
});
