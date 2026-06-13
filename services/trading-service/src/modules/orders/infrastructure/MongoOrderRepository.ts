import type { Db } from 'mongodb';
import { type Order, OrderStatus } from '../domain/Order.ts';
import type { IOrderRepository } from '../domain/IOrderRepository.ts';
import { COLLECTIONS } from '@trader/shared-mongo';
import { identityOf, tickerOf, tryIdentityOf } from '../../../shared/identity.ts';

export class MongoOrderRepository implements IOrderRepository {
  private col;

  constructor(db: Db) {
    this.col = db.collection(COLLECTIONS.ORDERS);
  }

  async save(order: Order): Promise<void> {
    await this.col.updateOne({ _id: order.id as any }, { $set: this._toDoc(order) }, { upsert: true });
  }

  async findById(id: string): Promise<Order | null> {
    const doc = await this.col.findOne({ _id: id as any });
    return doc ? this._fromDoc(doc) : null;
  }

  async findBySignalId(signalId: string): Promise<Order | null> {
    const doc = await this.col.findOne({ signalId });
    return doc ? this._fromDoc(doc) : null;
  }

  async findRecent(limit: number): Promise<Order[]> {
    const docs = await this.col.find({}).sort({ timestamp: -1 }).limit(limit).toArray();
    return docs.map((d) => this._fromDoc(d));
  }

  async findOpen(): Promise<Order[]> {
    const docs = await this.col.find({
      status: OrderStatus.Submitted,
      t212OrderId: { $exists: true, $ne: '' },
    }).toArray();
    return docs.map((d) => this._fromDoc(d));
  }

  async findInflightByTicker(ticker: string): Promise<Order[]> {
    // Orders are keyed on (symbol, market) since Task 16a; split the T212 ticker before the Mongo
    // touch. Fail-soft: an un-routable name nets no in-flight orders (the dispatcher then sizes off
    // the position alone) rather than throwing the sizing path.
    const id = tryIdentityOf(ticker);
    if (!id) return [];
    const docs = await this.col.find({
      symbol: id.symbol,
      market: id.market,
      status: OrderStatus.Submitted,
    }).toArray();
    return docs.map((d) => this._fromDoc(d));
  }

  // Order entity → Mongo doc. The in-memory Order carries the concatenated T212 `ticker`; storage
  // carries the bare (symbol, market) identity. Split here, drop `ticker`, and key the doc by _id.
  // An order is always for a tradable US/LSE name, so a parse failure is a real bug — surface it.
  private _toDoc(order: Order): Record<string, unknown> {
    const { ticker, ...rest } = order;
    const { symbol, market } = identityOf(ticker);
    return { ...rest, symbol, market, _id: order.id };
  }

  // Mongo doc → Order entity. Re-derive the T212 `ticker` from the stored identity so the Order
  // contract is byte-identical for downstream (the broker call, the fills ledger, logs). A
  // legacy/corrupt doc that still has a bare `ticker` (or an unrecognised market) falls back to it.
  private _fromDoc(doc: any): Order {
    const { _id, symbol, market, ticker: legacyTicker, ...rest } = doc;
    const ticker = this._tickerFromDoc(symbol, market, legacyTicker);
    return { id: _id, ticker, ...rest } as Order;
  }

  private _tickerFromDoc(symbol: unknown, market: unknown, legacyTicker: unknown): string {
    if (typeof symbol === 'string' && typeof market === 'string') {
      try { return tickerOf(symbol, market); } catch { /* fall through to legacy field */ }
    }
    return typeof legacyTicker === 'string' ? legacyTicker : '';
  }
}
