import type { StrategyOutput } from '@trader/shared-types';
import { REDIS_STREAMS } from '@trader/shared-types';
import { ensureConsumerGroup, xReadGroup, xAck } from '@trader/shared-redis';
import type { RedisClientType } from 'redis';
import type { Logger } from '@trader/core';

export interface RedisStrategySubscriberOptions {
    consumerName: string;
    logger: Logger;
    // Per-instance overrides. Each (stream, consumerGroup) pair runs its own loop so
    // wiring can multiplex across the per-worker output streams introduced in WP2
    // (`signals:strategy:5m:factor_rank_v1`, `signals:strategy:daily:factor_rank_v1`, …)
    // while keeping the legacy `signals:strategy` attached for cutover compatibility.
    // Defaults preserve the pre-WP2 behaviour for any caller that doesn't pass these.
    stream?: string;
    consumerGroup?: string;
}

export class RedisStrategySubscriber {
    private readonly stream: string;
    private readonly consumerGroup: string;

    constructor(
        private readonly redis: RedisClientType,
        private readonly opts: RedisStrategySubscriberOptions,
    ) {
        this.stream        = opts.stream        ?? REDIS_STREAMS.STRATEGY_OUTPUT;
        this.consumerGroup = opts.consumerGroup ?? 'signal-service';
    }

    async subscribe(handler: (features: StrategyOutput) => Promise<void>): Promise<void> {
        // Each subscriber duplicates the Redis client so its 5s-blocking xReadGroup
        // doesn't hog the shared connection. node-redis v4 pipelines commands on one
        // TCP socket per client — a blocking command serializes everything else,
        // including unrelated request-path GETs. Three multiplexed subscribers on the
        // shared client caused /admin/api/signals/auto-approve (a single GET) to take
        // ~13s as it queued behind 3×5s blocking reads. Dedicated clients fix it.
        const sub = this.redis.duplicate();
        sub.on('error', (err: unknown) => this.opts.logger.warn({ err, stream: this.stream }, 'subscriber client error'));
        await sub.connect();
        this.subClient = sub;

        await ensureConsumerGroup(sub, this.stream, this.consumerGroup);
        this.opts.logger.info(
            { stream: this.stream, group: this.consumerGroup, consumer: this.opts.consumerName },
            'strategy subscriber: starting runLoop',
        );
        this.runLoop(handler).catch((err: unknown) => {
            this.opts.logger.error({ err, stream: this.stream }, 'strategy subscriber loop crashed');
        });
    }

    private subClient: RedisClientType | null = null;

    private async runLoop(handler: (features: StrategyOutput) => Promise<void>): Promise<void> {
        const sub = this.subClient!;
        let pollCounter = 0;
        while (true) {
            pollCounter++;
            const entries = await xReadGroup(
                sub,
                this.consumerGroup,
                this.opts.consumerName,
                this.stream,
                5,
                5000,
            );
            if (entries.length === 0) {
                // Log every 12th idle poll (~once per minute at 5s block) so k9s shows
                // the consumer is alive even when strategy-engine is silent.
                if (pollCounter % 12 === 0) {
                    this.opts.logger.info({ pollCounter, stream: this.stream }, 'strategy subscriber: idle (no new strategy outputs in last ~60s)');
                }
                continue;
            }
            this.opts.logger.info({ count: entries.length, pollCounter, stream: this.stream }, 'strategy subscriber: received entries');
            for (const { id, data } of entries) {
                const startMs = Date.now();
                const features = data as StrategyOutput;
                const universeSize = (features?.ticker_universe ?? []).length;
                this.opts.logger.info(
                    { stream: this.stream, streamId: id, strategy_id: features?.strategy_id, ts: features?.timestamp, universeSize, regime_confidence: features?.regime_confidence },
                    'handling strategy output',
                );
                try {
                    await handler(features);
                    this.opts.logger.info(
                        { stream: this.stream, streamId: id, durationMs: Date.now() - startMs },
                        'handled strategy output',
                    );
                    await xAck(sub, this.stream, this.consumerGroup, id);
                } catch (err) {
                    this.opts.logger.error({ err, stream: this.stream, streamId: id, durationMs: Date.now() - startMs }, 'processing error');
                    // Do not ACK — message stays in PEL for retry/inspection.
                }
            }
        }
    }
}
