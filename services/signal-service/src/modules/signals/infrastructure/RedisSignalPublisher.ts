import type { ISignalPublisher } from '../domain/ISignalPublisher.ts';
import type { TradeSignal } from '../domain/TradeSignal.ts';
import { xAdd } from '@trader/shared-redis';
import { REDIS_STREAMS } from '@trader/shared-types';
import type { RedisClientType } from 'redis';

export class RedisSignalPublisher implements ISignalPublisher {
  constructor(private readonly redis: RedisClientType) {}

  async publish(signal: TradeSignal): Promise<void> {
    await xAdd(this.redis, REDIS_STREAMS.TRADE_SIGNALS, signal);
  }
}
