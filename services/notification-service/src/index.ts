import { Hono } from 'hono';
import { getRedisClient } from '@trader/shared-redis';
import { ensureConsumerGroup, xReadGroup, xAck } from '@trader/shared-redis';
import { REDIS_STREAMS } from '@trader/shared-types';
import { sendEmail } from './email.ts';
import { sendPush } from './push.ts';
import type { TradeSignalDTO } from '@trader/shared-types';

const app = new Hono();

const CONSUMER_GROUP = 'notification-service';
const CONSUMER_NAME  = `notification-service-${process.env.POD_NAME ?? 'local'}`;

async function notificationLoop(): Promise<void> {
  const redis = await getRedisClient();
  await ensureConsumerGroup(redis, REDIS_STREAMS.TRADE_SIGNALS, CONSUMER_GROUP);

  while (true) {
    const entries = await xReadGroup(
      redis,
      CONSUMER_GROUP,
      CONSUMER_NAME,
      REDIS_STREAMS.TRADE_SIGNALS,
      10,
      5000,
    );

    for (const { id, data } of entries) {
      const signal = data as TradeSignalDTO;
      try {
        // Deduplication: skip if already delivered within 4 hours
        const dedupKey = `notif:dedup:${signal.ticker}:${signal.action}`;
        const alreadySent = await redis.get(dedupKey);
        if (alreadySent) {
          console.log(`[notification] dedup skip ${signal.ticker} ${signal.action}`);
          await xAck(redis, REDIS_STREAMS.TRADE_SIGNALS, CONSUMER_GROUP, id);
          continue;
        }

        await Promise.allSettled([
          sendEmail(signal),
          sendPush(signal),
        ]);

        // Mark as delivered in MongoDB + set dedup key (4-hour window)
        await redis.setEx(dedupKey, 4 * 3600, '1');
        await redis.setEx(`notif:delivered:${signal.id}`, 86400, '1');

        await xAck(redis, REDIS_STREAMS.TRADE_SIGNALS, CONSUMER_GROUP, id);
      } catch (e) {
        console.error('[notification] processing error on', id, e);
        // Do not ACK — stays in PEL for retry
      }
    }
  }
}

// Push token registration endpoint (called by mobile app on login)
app.post('/push/register', async (c) => {
  const { token } = await c.req.json<{ token: string }>();
  if (!token) return c.json({ error: 'token required' }, 400);
  const redis = await getRedisClient();
  await redis.sAdd('push:tokens', token);
  return c.json({ registered: true });
});

app.get('/health', (c) => c.json({ status: 'ok' }));

notificationLoop().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});

export default { port: 3004, fetch: app.fetch };
