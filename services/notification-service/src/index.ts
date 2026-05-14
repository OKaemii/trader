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
        // Per-signal-id dedup. The earlier (ticker, action, 4h) window swallowed every
        // recurring AAPL BUY emission; per-id means each unique signal gets exactly one
        // email even if the consumer retries (e.g. crash before ACK). New emission =
        // new id = new email.
        const dedupKey = `notif:delivered:${signal.id}`;
        const alreadySent = await redis.get(dedupKey);
        if (alreadySent) {
          console.log(`[notification] dedup skip — signal ${signal.id} already delivered`);
          await xAck(redis, REDIS_STREAMS.TRADE_SIGNALS, CONSUMER_GROUP, id);
          continue;
        }

        // Per-channel try/catch so a Resend failure is logged AND doesn't block push,
        // and vice versa. Errors surface as warnings (allSettled previously swallowed them).
        const tag = `${signal.action} ${signal.ticker} (${signal.id.slice(0, 8)})`;
        await Promise.allSettled([
          (async () => {
            try { await sendEmail(signal); console.log(`[notification] email sent — ${tag}`); }
            catch (e) { console.warn(`[notification] email FAILED — ${tag}:`, e instanceof Error ? e.message : e); }
          })(),
          (async () => {
            try { await sendPush(signal); }
            catch (e) { console.warn(`[notification] push FAILED — ${tag}:`, e instanceof Error ? e.message : e); }
          })(),
        ]);

        // 24-hour TTL: covers consumer-retry safety without permanently pinning ids.
        await redis.setEx(dedupKey, 86400, '1');
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
