import type { Logger } from "@trader/core";
import type { RedisClientType } from "redis";
import { ensureConsumerGroup, xReadGroup, xAck } from "@trader/shared-redis";
import { REDIS_STREAMS, type TradeSignalDTO } from "@trader/shared-types";
import type { EmailSender } from "../email.ts";
import type { PushSender } from "../push.ts";

const CONSUMER_GROUP = "notification-service";

export interface NotificationLoopDeps {
    redis: RedisClientType;
    consumerName: string;
    email: EmailSender | null;
    push: PushSender;
    logger: Logger;
}

/**
 * Consumes the `signals:trade` Redis stream and dispatches per-channel notifications.
 * Per-signal-id dedup ensures each unique signal gets one email + one push even if the
 * consumer retries (crash before ACK). 24h TTL covers retry safety without pinning ids.
 */
export class NotificationLoop {
    private stopped = false;

    constructor(private readonly deps: NotificationLoopDeps) {}

    stop(): void { this.stopped = true; }

    async run(): Promise<void> {
        await ensureConsumerGroup(this.deps.redis, REDIS_STREAMS.TRADE_SIGNALS, CONSUMER_GROUP);

        while (!this.stopped) {
            const entries = await xReadGroup(
                this.deps.redis,
                CONSUMER_GROUP,
                this.deps.consumerName,
                REDIS_STREAMS.TRADE_SIGNALS,
                10,
                5000,
            );

            for (const { id, data } of entries) {
                const signal = data as TradeSignalDTO;
                try {
                    const dedupKey = `notif:delivered:${signal.id}`;
                    const alreadySent = await this.deps.redis.get(dedupKey);
                    if (alreadySent) {
                        this.deps.logger.info({ signalId: signal.id }, "dedup skip — already delivered");
                        await xAck(this.deps.redis, REDIS_STREAMS.TRADE_SIGNALS, CONSUMER_GROUP, id);
                        continue;
                    }

                    const tag = `${signal.action} ${signal.ticker} (${signal.id.slice(0, 8)})`;
                    await Promise.allSettled([
                        (async () => {
                            if (!this.deps.email) return;
                            try { await this.deps.email.send(signal); this.deps.logger.info({ tag }, "email sent"); }
                            catch (err) { this.deps.logger.warn({ err, tag }, "email FAILED"); }
                        })(),
                        (async () => {
                            try { await this.deps.push.send(signal); }
                            catch (err) { this.deps.logger.warn({ err, tag }, "push FAILED"); }
                        })(),
                    ]);

                    await this.deps.redis.setEx(dedupKey, 86400, "1");
                    await xAck(this.deps.redis, REDIS_STREAMS.TRADE_SIGNALS, CONSUMER_GROUP, id);
                } catch (err) {
                    this.deps.logger.error({ err, id }, "processing error");
                    // Don't ACK — stays in PEL for retry.
                }
            }
        }
    }
}
