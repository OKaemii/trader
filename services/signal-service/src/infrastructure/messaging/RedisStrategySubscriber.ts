import type { StrategyOutput } from '@trader/shared-types';
import { REDIS_STREAMS } from '@trader/shared-types';
import { ensureConsumerGroup, xReadGroup, xAck } from '@trader/shared-redis';
import type { RedisClientType } from 'redis';
import type { Logger } from '@trader/core';

const CONSUMER_GROUP = 'signal-service';

export interface RedisStrategySubscriberOptions {
    consumerName: string;
    logger: Logger;
}

export class RedisStrategySubscriber {
    constructor(
        private readonly redis: RedisClientType,
        private readonly opts: RedisStrategySubscriberOptions,
    ) {}

    async subscribe(handler: (features: StrategyOutput) => Promise<void>): Promise<void> {
        await ensureConsumerGroup(this.redis, REDIS_STREAMS.STRATEGY_OUTPUT, CONSUMER_GROUP);
        this.runLoop(handler).catch((err: unknown) => {
            this.opts.logger.error({ err }, 'strategy subscriber loop crashed');
        });
    }

    private async runLoop(handler: (features: StrategyOutput) => Promise<void>): Promise<void> {
        while (true) {
            const entries = await xReadGroup(
                this.redis,
                CONSUMER_GROUP,
                this.opts.consumerName,
                REDIS_STREAMS.STRATEGY_OUTPUT,
                5,
                5000,
            );
            for (const { id, data } of entries) {
                try {
                    await handler(data as StrategyOutput);
                    await xAck(this.redis, REDIS_STREAMS.STRATEGY_OUTPUT, CONSUMER_GROUP, id);
                } catch (err) {
                    this.opts.logger.error({ err, streamId: id }, 'processing error');
                    // Do not ACK — message stays in PEL for retry/inspection.
                }
            }
        }
    }
}
