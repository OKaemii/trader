import type { StrategyOutput } from '@trader/shared-types';
import { REDIS_STREAMS } from '@trader/shared-types';
import { ensureConsumerGroup, xReadGroup, xAck } from '@trader/shared-redis';
import type { RedisClientType } from 'redis';

const CONSUMER_GROUP = 'signal-service';
const CONSUMER_NAME  = `signal-service-${process.env.POD_NAME ?? 'local'}`;

export class RedisStrategySubscriber {
  constructor(private readonly redis: RedisClientType) {}

  async subscribe(handler: (features: StrategyOutput) => Promise<void>): Promise<void> {
    await ensureConsumerGroup(this.redis, REDIS_STREAMS.STRATEGY_OUTPUT, CONSUMER_GROUP);
    this.runLoop(handler).catch(console.error);
  }

  private async runLoop(handler: (features: StrategyOutput) => Promise<void>): Promise<void> {
    while (true) {
      const entries = await xReadGroup(
        this.redis,
        CONSUMER_GROUP,
        CONSUMER_NAME,
        REDIS_STREAMS.STRATEGY_OUTPUT,
        5,
        5000,
      );
      for (const { id, data } of entries) {
        try {
          await handler(data as StrategyOutput);
          await xAck(this.redis, REDIS_STREAMS.STRATEGY_OUTPUT, CONSUMER_GROUP, id);
        } catch (e) {
          console.error('[signal-service] processing error on', id, e);
          // Do not ACK — message stays in PEL for retry/inspection
        }
      }
    }
  }
}
