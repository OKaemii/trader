import type { Order } from './Order.ts';

export interface IOrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
  findBySignalId(signalId: string): Promise<Order | null>;
  findRecent(limit: number): Promise<Order[]>;
  findOpen(): Promise<Order[]>;   // status === OrderStatus.Submitted AND has a t212OrderId
  // In-flight orders for a single ticker — placed at broker but not yet filled. Used by
  // OrderDispatcher to avoid double-sizing back-to-back signals before the first one fills
  // (real-world case: XUSEl_EQ got two BUYs across consecutive cycles because T212 hadn't
  // reported the first fill yet, so the position snapshot still showed currentQuantity=0).
  findInflightByTicker(ticker: string): Promise<Order[]>;
}
