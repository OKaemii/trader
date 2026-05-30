import type { Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import { OrderStatus } from '../../orders/domain/Order.ts';
import type { Healer } from '../application/Reconciliation.ts';

// The ONLY component that mutates money-bearing state from a reconciliation result. Gated by
// the engine's autoHealEnabled flag (observe-only until the operator trusts it) and only ever
// invoked for findings the pure checks marked autoHealable (sub-threshold position drift;
// broker-terminal order-state drift). Broker is treated as truth — these writes converge the
// system view onto it. Every heal stamps `source` so the row is traceable to reconciliation.
export class MongoHealer implements Healer {
  constructor(private readonly db: Db) {}

  async healPositionQuantity(ticker: string, brokerQty: number, cycleId: string): Promise<void> {
    await this.db.collection(COLLECTIONS.POSITIONS).updateOne(
      { ticker },
      {
        $set: {
          quantity: brokerQty,
          source: 'reconciliation_auto_heal',
          updatedAt: new Date(),
          lastReconcileCycle: cycleId,
        },
      },
      { upsert: true },
    );
  }

  async healOrderState(orderId: string, cycleId: string): Promise<void> {
    // Mongo says submitted; T212 history says terminal (cancelled/rejected/expired) → converge.
    await this.db.collection(COLLECTIONS.ORDERS).updateOne(
      { id: orderId },
      { $set: { status: OrderStatus.Cancelled, lastReconcileCycle: cycleId } },
    );
  }
}
