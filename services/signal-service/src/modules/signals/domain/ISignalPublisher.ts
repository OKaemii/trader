import type { TradeSignal } from './TradeSignal.ts';

export interface ISignalPublisher {
  publish(signal: TradeSignal): Promise<void>;
}
