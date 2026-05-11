import type { TradeSignal } from '../entities/TradeSignal.ts';

export interface ISignalPublisher {
  publish(signal: TradeSignal): Promise<void>;
}
