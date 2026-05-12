import type { TradeSignal } from '../entities/TradeSignal.ts';

export interface ISignalRepository {
  save(signal: TradeSignal): Promise<void>;
  findById(id: string): Promise<TradeSignal | null>;
  findRecent(limit: number): Promise<TradeSignal[]>;
  approve(id: string): Promise<void>;
  markExecuted(id: string, at: number): Promise<void>;
  markClosed(id: string, at: number, exitPrice: number): Promise<void>;
}
