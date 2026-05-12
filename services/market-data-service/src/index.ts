import { Hono } from 'hono';
import { getRedisClient, xAdd, ensureConsumerGroup } from '@trader/shared-redis';
import { getMongoDb } from '@trader/shared-mongo';
import { COLLECTIONS } from '@trader/shared-mongo';
import { fetchYahooPrices } from './yahoo-client.ts';
import { BarValidator } from './bar-validator.ts';
import { GapDetector } from './gap-detector.ts';
import { StaleDetector } from './stale-detector.ts';
import { UniverseManager } from './universe-manager.ts';
import { REDIS_STREAMS, type OHLCVBar } from '@trader/shared-types';

const app = new Hono();
// BAR_FREQUENCY=daily   → re-poll Yahoo every POLL_INTERVAL_MS (default 20m) until the
//                        EOD adjusted bar arrives; the cycle then idles until next close.
// BAR_FREQUENCY=intraday → poll at POLL_INTERVAL_MS (default 60s).
//
// The original 60m default was conservative — chosen when EOD bar latency wasn't well
// understood and the priority was avoiding hammering Yahoo. In practice the post-close
// bar lands within minutes, so 60m made signal generation lag a full cycle on bad days.
// 20m matches our observed publishing latency while staying well under any rate limit.
const BAR_FREQUENCY     = process.env.BAR_FREQUENCY ?? 'daily';
const DEFAULT_POLL_MS   = BAR_FREQUENCY === 'daily' ? 20 * 60 * 1000 : 60 * 1000;
const POLL_INTERVAL_MS  = parseInt(process.env.POLL_INTERVAL_MS ?? String(DEFAULT_POLL_MS));

// Universe refresh cadence: monthly in production; override via env for testing
const UNIVERSE_REFRESH_MS = parseInt(process.env.UNIVERSE_REFRESH_MS ?? String(30 * 24 * 60 * 60 * 1000));
// Gap threshold: skip cycle if more than this fraction of universe is missing.
// Raise via GAP_THRESHOLD env for demo universes with many T212-only tickers (no Yahoo equivalent).
const GAP_THRESHOLD = parseFloat(process.env.GAP_THRESHOLD ?? '0.20');

const validator  = new BarValidator();
const gapDetector = new GapDetector(POLL_INTERVAL_MS);
const staleDetector = new StaleDetector(POLL_INTERVAL_MS * 3);
const universeManager = new UniverseManager();

async function persistBars(bars: OHLCVBar[]): Promise<void> {
  const db = await getMongoDb();
  await db.collection(COLLECTIONS.OHLCV_BARS).insertMany(
    bars.map((bar) => ({
      ticker:          bar.ticker,
      timestamp:       new Date(bar.timestamp),
      open:            bar.open,
      high:            bar.high,
      low:             bar.low,
      close:           bar.close,
      volume:          bar.volume,
      rawClose:        bar.rawClose ?? bar.close,
      adjustedClose:   bar.adjustedClose,
      adjustmentFactor: bar.adjustmentFactor,
    })),
  );
}

async function pollLoop(): Promise<void> {
  const redis = await getRedisClient();
  await ensureConsumerGroup(redis, REDIS_STREAMS.MARKET_RAW, 'market-data-service');

  // Build initial universe from T212 instruments + instrument_registry
  let activeTickers = await universeManager.refresh();
  if (activeTickers.length === 0) {
    // Fallback to env var seed list if registry is empty
    activeTickers = (process.env.TICKER_UNIVERSE ?? 'AAPL,MSFT,GOOGL,AMZN,NVDA,TSLA,META,NFLX,AMD,INTC').split(',');
    console.warn(`[market-data] universe empty — using TICKER_UNIVERSE env: ${activeTickers.join(',')}`);
  }
  let lastUniverseRefresh = Date.now();

  while (true) {
    // Monthly universe refresh
    if (Date.now() - lastUniverseRefresh > UNIVERSE_REFRESH_MS) {
      activeTickers = await universeManager.refresh();
      lastUniverseRefresh = Date.now();
    }

    try {
      const rawBars = await fetchYahooPrices(activeTickers);

      // Stale detection: skip bars that are too old
      const { fresh, stale } = staleDetector.check(rawBars);
      if (stale.length > 0) {
        console.warn(`[market-data] ${stale.length} stale bars skipped: ${stale.map(b => b.ticker).join(',')}`);
      }

      const { valid, invalid } = validator.validate(fresh);

      if (invalid.length > 0) {
        const db = await getMongoDb();
        await db.collection(COLLECTIONS.BAD_TICKS).insertMany(
          invalid.map(({ bar, reason }) => ({ ...bar, reason, loggedAt: new Date() })),
        );
        console.warn(`[market-data] ${invalid.length} bad ticks rejected`);
      }

      // Gap detection: if too many universe members are missing, skip the cycle
      const gapReport = gapDetector.check(activeTickers, valid);
      if (gapReport.gapFraction > GAP_THRESHOLD) {
        const db = await getMongoDb();
        await db.collection(COLLECTIONS.BAD_TICKS).insertOne({
          type: 'universe_gap',
          missingTickers: gapReport.missingTickers,
          gapFraction: gapReport.gapFraction,
          timestamp: Date.now(),
          loggedAt: new Date(),
        });
        console.warn(`[market-data] ${(gapReport.gapFraction * 100).toFixed(0)}% of universe missing — skipping strategy cycle`);
        await Bun.sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (valid.length > 0) {
        await persistBars(valid);
        await xAdd(redis, REDIS_STREAMS.MARKET_RAW, valid);

        for (const bar of valid) {
          await redis.setEx(`market:latest:${bar.ticker}`, 120, JSON.stringify(bar));
        }

        pollStats.lastPollTs   = Date.now();
        pollStats.lastBarCount = valid.length;
        pollStats.totalCycles++;
        console.log(`[market-data] published ${valid.length} bars (cycle ${pollStats.totalCycles})`);
      }
    } catch (e) {
      console.error('[market-data] poll error:', e);
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

// Poll stats updated each cycle for /health visibility
const pollStats = { lastPollTs: null as number | null, lastBarCount: 0, totalCycles: 0 };

app.get('/health', (c) => c.json({
  status:       'ok',
  bar_frequency: BAR_FREQUENCY,
  universe_size: universeManager.activeTickers.length,
  last_poll_ts:  pollStats.lastPollTs,
  last_bar_count: pollStats.lastBarCount,
  total_cycles:  pollStats.totalCycles,
}));

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
