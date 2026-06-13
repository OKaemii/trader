import type { Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import { OrderStatus } from '../../orders/domain/Order.ts';
import type { Healer } from '../application/Reconciliation.ts';
import { tryIdentityOf } from '../../../shared/identity.ts';

// The ONLY component that mutates money-bearing state from a reconciliation result. Gated by
// the engine's autoHealEnabled flag (observe-only until the operator trusts it) and only ever
// invoked for findings the pure checks marked autoHealable (sub-threshold position drift;
// broker-terminal order-state drift). Broker is treated as truth — these writes converge the
// system view onto it. Every heal stamps `source` so the row is traceable to reconciliation.
export class MongoHealer implements Healer {
  constructor(private readonly db: Db) {}

  async healPositionQuantity(ticker: string, brokerQty: number, cycleId: string): Promise<void> {
    // Positions are keyed on (symbol, market) since Task 16a; split the T212 ticker before the
    // upsert. An un-routable ticker is skipped (it can't key a position row) rather than inserting
    // an unkeyed document.
    const id = tryIdentityOf(ticker);
    if (!id) return;
    await this.db.collection(COLLECTIONS.POSITIONS).updateOne(
      { symbol: id.symbol, market: id.market },
      {
        $set: {
          symbol: id.symbol,
          market: id.market,
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
