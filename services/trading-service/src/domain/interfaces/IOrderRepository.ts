import type { Order } from '../entities/Order.ts';

export interface IOrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
  findBySignalId(signalId: string): Promise<Order | null>;
  findRecent(limit: number): Promise<Order[]>;
}
