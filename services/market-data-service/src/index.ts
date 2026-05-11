import { Hono } from 'hono';
import { getRedisClient, xAdd, ensureConsumerGroup } from '@trader/shared-redis';
import { getMongoDb } from '@trader/shared-mongo';
import { COLLECTIONS, REDIS_STREAMS } from '@trader/shared-types';
import { fetchT212Prices } from './t212-client.ts';
import { BarValidator } from './bar-validator.ts';
import type { OHLCVBar } from '@trader/shared-types';

const app = new Hono();
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '60000');
const TICKERS = (process.env.TICKER_UNIVERSE ?? 'AAPL,MSFT,GOOGL,AMZN,NVDA,TSLA,META,NFLX,AMD,INTC').split(',');

const validator = new BarValidator();

async function persistBars(bars: OHLCVBar[]): Promise<void> {
  const db = await getMongoDb();
  await db.collection(COLLECTIONS.OHLCV_BARS).insertMany(
    bars.map((bar) => ({
      ticker: bar.ticker,
      timestamp: new Date(bar.timestamp),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    })),
  );
}

async function pollLoop(): Promise<void> {
  const redis = await getRedisClient();
  await ensureConsumerGroup(redis, REDIS_STREAMS.MARKET_RAW, 'market-data-service');

  while (true) {
    try {
      const rawBars = await fetchT212Prices(TICKERS);
      const { valid, invalid } = validator.validate(rawBars);

      if (invalid.length > 0) {
        const db = await getMongoDb();
        await db.collection(COLLECTIONS.BAD_TICKS).insertMany(
          invalid.map(({ bar, reason }) => ({ ...bar, reason, loggedAt: new Date() })),
        );
        console.warn(`[market-data] ${invalid.length} bad ticks rejected`);
      }

      if (valid.length > 0) {
        await persistBars(valid);
        await xAdd(redis, REDIS_STREAMS.MARKET_RAW, valid);

        // Cache latest bar per ticker (120s TTL — prices change every minute)
        for (const bar of valid) {
          await redis.setEx(`market:latest:${bar.ticker}`, 120, JSON.stringify(bar));
        }

        console.log(`[market-data] published ${valid.length} bars`);
      }
    } catch (e) {
      console.error('[market-data] poll error:', e);
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/latest/:ticker', async (c) => {
  const redis = await getRedisClient();
  const raw = await redis.get(`market:latest:${c.req.param('ticker')}`);
  return raw ? c.json(JSON.parse(raw)) : c.json({ error: 'not found' }, 404);
});

pollLoop().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});

export default { port: 3002, fetch: app.fetch };
