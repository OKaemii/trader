import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import type { TradeSignalDTO } from '@trader/shared-types';
import { getRedisClient } from '@trader/shared-redis';

const expo = new Expo();

export async function sendPush(signal: TradeSignalDTO): Promise<void> {
  const redis = await getRedisClient();
  // Push tokens registered by mobile app on login, stored in Redis set
  const tokens = await redis.sMembers('push:tokens');
  if (tokens.length === 0) return;

  const rationale = (() => {
    try { return JSON.parse(signal.rationale); } catch { return { plain_english: signal.rationale }; }
  })();

  const messages = tokens
    .filter(Expo.isExpoPushToken)
    .map((to) => ({
      to,
      sound: 'default' as const,
      title: `${signal.action === 'BUY' ? '📈' : '📉'} ${signal.action} ${signal.ticker}`,
      body: rationale.plain_english ?? signal.rationale,
      data: { signalId: signal.id },
    }));

  const chunks = expo.chunkPushNotifications(messages);
  await Promise.all(chunks.map((chunk: ExpoPushMessage[]) => expo.sendPushNotificationsAsync(chunk)));
}
