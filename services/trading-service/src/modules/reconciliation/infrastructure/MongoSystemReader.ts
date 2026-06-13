import type { Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import { OrderSide, OrderStatus } from '../../orders/domain/Order.ts';
import type { OrderView, PositionView } from '../application/ReconciliationChecks.ts';
import type { SystemReader } from '../application/Reconciliation.ts';
import type { FillsHistoryStore } from './FillsHistoryStore.ts';
import { tickerOf } from '../../../shared/identity.ts';

// (symbol, market) → the T212 display ticker, falling back to the bare symbol / legacy field if the
// market is unrecognised. positions + orders store the bare identity since Task 16a; the
// reconciliation views render a ticker label (the actual T212 match is by orderId, not by ticker).
function tickerFromDoc(d: Record<string, unknown>): string {
  if (typeof d.symbol === 'string' && typeof d.market === 'string') {
    try { return tickerOf(d.symbol, d.market); } catch { /* fall through */ }
  }
  return typeof d.ticker === 'string' ? d.ticker : (typeof d.symbol === 'string' ? d.symbol : '');
}

// Reads system state (Mongo) as the minimal view types the pure checks consume. Fill ids come
// from the Timescale ledger (FillsHistoryStore). Kept thin: no business logic, just adaptation.
export class MongoSystemReader implements SystemReader {
  constructor(private readonly db: Db, private readonly fills: FillsHistoryStore) {}

  async positions(): Promise<PositionView[]> {
    const docs = await this.db.collection(COLLECTIONS.POSITIONS).find({}).toArray();
    return docs.map((d) => ({
      ticker: tickerFromDoc(d),
      quantity: typeof d.quantity === 'number' ? d.quantity : 0,
    }));
  }

  async submittedOrders(): Promise<OrderView[]> {
    const docs = await this.db
      .collection(COLLECTIONS.ORDERS)
      .find({ status: OrderStatus.Submitted, t212OrderId: { $exists: true, $ne: null } })
      .toArray();
    return docs.map((d) => ({
      orderId: String(d.t212OrderId),                  // match T212 history order.id
      ticker: tickerFromDoc(d),
      side: d.side === OrderSide.Buy ? 'BUY' : 'SELL',
      status: 'submitted',                             // already filtered to Submitted
      signalId: d.signalId ? String(d.signalId) : null,
    }));
  }

  async ledgerFillIds(startMs: number, endMs: number): Promise<string[]> {
    return this.fills.readFillIds(startMs, endMs);
  }

  async knownOrderIds(t212OrderIds: string[]): Promise<Set<string>> {
    if (t212OrderIds.length === 0) return new Set();
    // Match in ANY status — a filled/cancelled order is still a system order, not out-of-band.
    const docs = await this.db
      .collection(COLLECTIONS.ORDERS)
      .find({ t212OrderId: { $in: t212OrderIds } }, { projection: { t212OrderId: 1 } })
      .toArray();
    return new Set(docs.map((d) => String(d.t212OrderId)));
  }
}
