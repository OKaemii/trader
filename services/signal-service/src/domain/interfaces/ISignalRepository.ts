import type { TradeSignal } from '../entities/TradeSignal.ts';

export interface ISignalRepository {
  save(signal: TradeSignal): Promise<void>;
  findById(id: string): Promise<TradeSignal | null>;
  findRecent(limit: number): Promise<TradeSignal[]>;
  approve(id: string): Promise<void>;
  markExecuted(id: string, at: number, executedQuantity?: number): Promise<void>;
  markClosed(id: string, at: number, exitPrice: number): Promise<void>;
  // FIFO round-trip closure: returns executed BUY signals for a ticker, oldest-first by
  // executedAt, with non-zero executedQuantity. SELL fills walk this list to attribute shares.
  findOpenBuysByTicker(ticker: string): Promise<TradeSignal[]>;
  // Decrements an open BUY signal's executedQuantity (used when a SELL only partially
  // consumes the next BUY in FIFO order). Caller is responsible for not driving below zero.
  decrementExecutedQuantity(id: string, by: number): Promise<void>;
}
