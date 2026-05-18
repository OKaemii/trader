import type { Db } from 'mongodb';
import { type Order, OrderStatus } from '../domain/Order.ts';
import type { IOrderRepository } from '../domain/IOrderRepository.ts';
import { COLLECTIONS } from '@trader/shared-mongo';

export class MongoOrderRepository implements IOrderRepository {
  private col;

  constructor(db: Db) {
    this.col = db.collection(COLLECTIONS.ORDERS);
  }

  async save(order: Order): Promise<void> {
    await this.col.updateOne({ _id: order.id as any }, { $set: { ...order, _id: order.id } }, { upsert: true });
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

  private _fromDoc(doc: any): Order {
    const { _id, ...rest } = doc;
    return { id: _id, ...rest } as Order;
  }
}
