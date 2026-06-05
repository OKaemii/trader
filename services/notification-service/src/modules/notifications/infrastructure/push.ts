import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import type { RedisClientType } from 'redis';
import type { TradeSignalDTO } from '@trader/shared-types';

export class PushSender {
    private readonly expo = new Expo();

    constructor(private readonly redis: Pick<RedisClientType, 'sMembers'>) {}

    async send(signal: TradeSignalDTO): Promise<void> {
        // Push tokens registered by mobile app on login, stored in Redis set
        const tokens = await this.redis.sMembers('push:tokens');
        if (tokens.length === 0) return;

        const rationale = (() => {
            try { return JSON.parse(signal.rationale) as { plain_english?: string }; }
            catch { return { plain_english: signal.rationale }; }
        })();

        const validTokens: string[] = tokens.filter((t: string): t is string => Expo.isExpoPushToken(t));
        const messages: ExpoPushMessage[] = validTokens.map((to: string) => ({
            to,
            sound: 'default' as const,
            title: `${signal.action === 'BUY' ? '📈' : '📉'} ${signal.action} ${signal.ticker}`,
            body:  rationale.plain_english ?? signal.rationale,
            data:  { signalId: signal.id },
        }));

        const chunks = this.expo.chunkPushNotifications(messages);
        await Promise.all(chunks.map((chunk: ExpoPushMessage[]) => this.expo.sendPushNotificationsAsync(chunk)));
    }

    /**
     * One aggregated push per digest cycle — the real-time counterpart to the aggregated email,
     * so the operator gets a single tap summarising the whole rebalance instead of one per signal.
     */
    async sendDigest(args: { title: string; body: string; data?: Record<string, unknown> }): Promise<void> {
        const tokens = await this.redis.sMembers('push:tokens');
        if (tokens.length === 0) return;
        const validTokens: string[] = tokens.filter((t: string): t is string => Expo.isExpoPushToken(t));
        const messages: ExpoPushMessage[] = validTokens.map((to: string) => ({
            to,
            sound: 'default' as const,
            title: args.title,
            body:  args.body,
            ...(args.data ? { data: args.data } : {}),
        }));
        const chunks = this.expo.chunkPushNotifications(messages);
        await Promise.all(chunks.map((chunk: ExpoPushMessage[]) => this.expo.sendPushNotificationsAsync(chunk)));
    }
}
