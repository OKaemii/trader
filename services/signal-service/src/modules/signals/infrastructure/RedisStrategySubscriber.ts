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
        this.opts.logger.info(
            { stream: REDIS_STREAMS.STRATEGY_OUTPUT, group: CONSUMER_GROUP, consumer: this.opts.consumerName },
            'strategy subscriber: starting runLoop',
        );
        this.runLoop(handler).catch((err: unknown) => {
            this.opts.logger.error({ err }, 'strategy subscriber loop crashed');
        });
    }

    private async runLoop(handler: (features: StrategyOutput) => Promise<void>): Promise<void> {
        let pollCounter = 0;
        while (true) {
            pollCounter++;
            const entries = await xReadGroup(
                this.redis,
                CONSUMER_GROUP,
                this.opts.consumerName,
                REDIS_STREAMS.STRATEGY_OUTPUT,
                5,
                5000,
            );
            if (entries.length === 0) {
                // Log every 12th idle poll (~once per minute at 5s block) so k9s shows
                // the consumer is alive even when strategy-engine is silent.
                if (pollCounter % 12 === 0) {
                    this.opts.logger.info({ pollCounter }, 'strategy subscriber: idle (no new strategy outputs in last ~60s)');
                }
                continue;
            }
            this.opts.logger.info({ count: entries.length, pollCounter }, 'strategy subscriber: received entries');
            for (const { id, data } of entries) {
                const startMs = Date.now();
                const features = data as StrategyOutput;
                const universeSize = (features?.ticker_universe ?? []).length;
                this.opts.logger.info(
                    { streamId: id, strategy_id: features?.strategy_id, ts: features?.timestamp, universeSize, regime_confidence: features?.regime_confidence },
                    'handling strategy output',
                );
                try {
                    await handler(features);
                    this.opts.logger.info(
                        { streamId: id, durationMs: Date.now() - startMs },
                        'handled strategy output',
                    );
                    await xAck(this.redis, REDIS_STREAMS.STRATEGY_OUTPUT, CONSUMER_GROUP, id);
                } catch (err) {
                    this.opts.logger.error({ err, streamId: id, durationMs: Date.now() - startMs }, 'processing error');
                    // Do not ACK — message stays in PEL for retry/inspection.
                }
            }
        }
    }
}
