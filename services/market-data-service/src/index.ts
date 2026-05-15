import { Hono } from 'hono';
import { getRedisClient, xAdd, ensureConsumerGroup } from '@trader/shared-redis';
import { getMongoDb } from '@trader/shared-mongo';
import { COLLECTIONS } from '@trader/shared-mongo';
import { BarValidator } from './bar-validator.ts';
import { GapDetector } from './gap-detector.ts';
import { StaleDetector } from './stale-detector.ts';
import { UniverseManager } from './universe-manager.ts';
import { getLiveConfig } from './live-config.ts';
import { createAdminRouter, createInternalBarsRouter } from './admin-routes.ts';
import { YahooProvider } from './providers/yahoo-provider.ts';
import { aggregateBars } from '@trader/shared-bars';
import { backfillTickers, tickersMissingHistory, healMissingHistory } from './backfill.ts';
import { msUntilNextTick } from './poll-scheduling.ts';

// Wall-clock anchor for the poll grid. 24h ticks land at this UTC offset (~1h after
// US close = 22:00 UTC); shorter intervals land at the same phase. Override via env
// for environments on a non-US calendar.
const POLL_ANCHOR_OFFSET_MS = parseInt(process.env.POLL_ANCHOR_OFFSET_MS ?? String(22 * 60 * 60_000), 10);
import { REDIS_STREAMS, type OHLCVBar, type BarInterval } from '@trader/shared-types';

const app = new Hono();
// BAR_FREQUENCY=daily   → re-poll Yahoo every POLL_INTERVAL_MS (default 20m) until the
//                        EOD adjusted bar arrives; the cycle then idles until next close.
// BAR_FREQUENCY=intraday → poll at POLL_INTERVAL_MS (default 60s).
//
// Effective values are resolved per poll-iteration via getLiveConfig() so portal
// overrides (portal_market_config) take effect without a service restart.
// Env values are used as the fallback when no override is set.

// Universe refresh cadence: monthly in production; override via env for testing
const UNIVERSE_REFRESH_MS = parseInt(process.env.UNIVERSE_REFRESH_MS ?? String(30 * 24 * 60 * 60 * 1000));
// Gap threshold: skip cycle if more than this fraction of universe is missing.
// Raise via GAP_THRESHOLD env for demo universes with many T212-only tickers (no Yahoo equivalent).
const GAP_THRESHOLD = parseFloat(process.env.GAP_THRESHOLD ?? '0.20');

const validator  = new BarValidator();
// Gap/stale detectors are initialized with the env-default poll interval; their
// thresholds aren't latency-critical so live-config changes don't need to rewire them.
const INITIAL_POLL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? String(
  (process.env.BAR_FREQUENCY ?? 'daily') === 'daily' ? 20 * 60 * 1000 : 60 * 1000,
));
const gapDetector = new GapDetector(INITIAL_POLL_MS);
const staleDetector = new StaleDetector(INITIAL_POLL_MS * 3);
const universeManager = new UniverseManager();

// Each insert is an upsert on (ticker, timestamp, interval) so re-polling the same EOD
// bar — which used to happen every 20m for the entire day and bloat the collection with
// duplicate rows — now overwrites the same row instead of stacking new copies. The unique
// index on those three fields is created lazily on startup; bulkWrite respects it.
async function persistBars(bars: OHLCVBar[], interval: BarInterval): Promise<void> {
  if (bars.length === 0) return;
  const db = await getMongoDb();
  const ops = bars.map((bar) => ({
    updateOne: {
      filter: { ticker: bar.ticker, timestamp: new Date(bar.timestamp), interval },
      update: {
        $set: {
          ticker:          bar.ticker,
          timestamp:       new Date(bar.timestamp),
          interval,
          open:            bar.open,
          high:            bar.high,
          low:             bar.low,
          close:           bar.close,
          volume:          bar.volume,
          rawClose:        bar.rawClose ?? bar.close,
          adjustedClose:   bar.adjustedClose,
          adjustmentFactor: bar.adjustmentFactor,
        },
      },
      upsert: true,
    },
  }));
  await db.collection(COLLECTIONS.OHLCV_BARS).bulkWrite(ops, { ordered: false });
}

/**
 * Downsample a heterogeneous batch of 5m bars (multiple tickers, multiple timestamps)
 * into one bar per ticker at `targetInterval`, keeping only the most recent bucket.
 *
 * Exported for testability — the pollLoop uses this to decide what to xAdd onto
 * market:raw each cycle. Strategy-engine treats every stream arrival as one rolling
 * window step, so we deliberately publish only the LATEST bar per ticker (not the
 * full history Yahoo returns).
 */
export function latestPerTicker(bars: OHLCVBar[], targetInterval: BarInterval): OHLCVBar[] {
  if (bars.length === 0) return [];
  const byTicker = new Map<string, OHLCVBar[]>();
  for (const b of bars) {
    let list = byTicker.get(b.ticker);
    if (!list) { list = []; byTicker.set(b.ticker, list); }
    list.push(b);
  }
  const out: OHLCVBar[] = [];
  for (const list of byTicker.values()) {
    const aggregated = aggregateBars(list, targetInterval);
    if (aggregated.length > 0) out.push(aggregated[aggregated.length - 1]);
  }
  return out;
}

// Ensure the unique compound index on every boot. Mongo no-ops if it already matches.
//
// Two failure modes worth knowing about (both caught on first deploy):
//
//   1. Existing duplicate rows from before the upsert switch can fail unique-index
//      creation. Mitigation: admin /clear-cache endpoint wipes legacy rows, then redeploy.
//
//   2. **If the collection was ever created as a time-series collection** (Mongo 5+
//      sometimes does this implicitly under certain Bitnami chart configurations),
//      it rejects createIndex({...}, {unique: true}) with "Unique indexes are not
//      supported on time-series collections" — AND rejects every subsequent updateOne
//      upsert with the same error. The fix is to detect this and re-create the
//      collection as a regular one. We can't auto-recreate (would lose data) so the
//      service logs loudly and exits — boot order requires the operator to drop and
//      recreate the collection manually before the dispatcher can write any bars.
async function ensureBarIndexes(): Promise<void> {
  const db = await getMongoDb();
  try {
    const info = await db.listCollections({ name: COLLECTIONS.OHLCV_BARS }).toArray();
    const coll = info[0];
    if (coll && (coll.type === 'timeseries' || (coll as any).options?.timeseries)) {
      console.error('[market-data] FATAL: ohlcv_bars is a time-series collection — unique indexes + updateOne upserts are unsupported. Run: db.ohlcv_bars.drop(); db.createCollection("ohlcv_bars"); then redeploy.');
      process.exit(1);
    }
  } catch (err) {
    console.warn('[market-data] could not check collection type:', err);
  }

  await db.collection(COLLECTIONS.OHLCV_BARS).createIndex(
    { ticker: 1, timestamp: 1, interval: 1 },
    { unique: true, name: 'ticker_timestamp_interval_unique' },
  ).catch((err) => {
    console.warn('[market-data] unique index ensure failed (likely existing duplicates):', err instanceof Error ? err.message : err);
  });
}

// Provider is swappable: pass a different MarketDataProvider here once a paid feed
// or broker-native source is wired. The pollLoop / admin-routes / universe-manager
// all consume the abstraction, never Yahoo-specific functions directly.
const provider = new YahooProvider();

async function pollLoop(): Promise<void> {
  const redis = await getRedisClient();
  await ensureConsumerGroup(redis, REDIS_STREAMS.MARKET_RAW, 'market-data-service');

  // Build initial universe from T212 instruments + instrument_registry
  let activeTickers = await universeManager.refresh();
  if (activeTickers.length === 0) {
    // Fallback to env var seed list if registry is empty
    activeTickers = (process.env.TICKER_UNIVERSE ?? 'AAPL_US_EQ,MSFT_US_EQ,GOOGL_US_EQ,AMZN_US_EQ,NVDA_US_EQ,TSLA_US_EQ,FB_US_EQ,NFLX_US_EQ,AMD_US_EQ,INTC_US_EQ').split(',');
    console.warn(`[market-data] universe empty — using TICKER_UNIVERSE env: ${activeTickers.join(',')}`);
  }
  let lastUniverseRefresh = Date.now();

  while (true) {
    const cfg = await getLiveConfig();
    const pollIntervalMs = cfg.pollIntervalMs;

    // Monthly universe refresh
    if (Date.now() - lastUniverseRefresh > UNIVERSE_REFRESH_MS) {
      activeTickers = await universeManager.refresh();
      lastUniverseRefresh = Date.now();
    }

    try {
      // Self-heal pass FIRST: one Mongo aggregation finds tickers whose latest 5m
      // bar predates fetchRecent's 24h window. fetchRecent can only cover the last
      // 24h, so anything older needs a targeted backfill. Steady-state cost when no
      // ticker is gapped: a single aggregation, no Yahoo calls.
      try {
        const db = await getMongoDb();
        const redis2 = await getRedisClient();
        const heal = await healMissingHistory(db, redis2, provider, activeTickers);
        if (heal.healed > 0) {
          console.warn(`[market-data] heal: ${heal.healed} ticker(s), ${heal.barsAdded} bars filled, ${heal.unrecoverable} unrecoverable`);
        }
      } catch (err) {
        console.warn('[market-data] heal pass failed (non-fatal):', err);
      }

      // Pull a window of 5m bars per ticker — one Yahoo /chart request per ticker
      // returns ~78 5m bars (a full trading day) at hourly cadence. Storage is always
      // 5m; what gets published to market:raw is downsampled to the active BAR_FREQUENCY
      // so strategy-engine's rolling-window math sees bars at the granularity it expects.
      const rawBars = await provider.fetchRecent(activeTickers, 24);

      // Validation runs on the full Yahoo response — bar-shape checks (positive prices,
      // OHLC sanity) are unrelated to age. Stale filter runs LATER, only against the
      // publish-to-stream path, so wider Yahoo responses (Yahoo sometimes returns more
      // than the requested window) still get persisted via the idempotent upsert.
      const { valid, invalid } = validator.validate(rawBars);

      if (invalid.length > 0) {
        const db = await getMongoDb();
        await db.collection(COLLECTIONS.BAD_TICKS).insertMany(
          invalid.map(({ bar, reason }) => ({ ...bar, reason, loggedAt: new Date() })),
        );
        console.warn(`[market-data] ${invalid.length} bad ticks rejected`);
      }

      // Gap detection: count *distinct tickers represented*, not raw bar count. With
      // fetchRecent returning ~78 bars per ticker, a raw-count check would always pass
      // even if half the universe failed to resolve.
      const representedTickers = new Set(valid.map((b) => b.ticker));
      const gapReport = gapDetector.check(
        activeTickers,
        activeTickers.filter((t) => representedTickers.has(t)).map((t) => ({ ticker: t } as OHLCVBar)),
      );
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
        await Bun.sleep(msUntilNextTick(pollIntervalMs, POLL_ANCHOR_OFFSET_MS));
        continue;
      }

      if (valid.length > 0) {
        // Persist EVERY valid bar — upsert dedups overlap, and a fresh deploy benefits
        // from caching wider Yahoo responses (e.g. the 60-day default range) cheaply.
        await persistBars(valid, '5m');

        // Downsample per ticker to BAR_FREQUENCY, then publish ONLY the latest bucket
        // per ticker to market:raw. See latestPerTicker for the rationale.
        const targetInterval: BarInterval = cfg.barFrequency === 'intraday' ? '15m' : 'daily';
        const downsampled = latestPerTicker(valid, targetInterval);

        await xAdd(redis, REDIS_STREAMS.MARKET_RAW, downsampled);
        for (const bar of downsampled) {
          await redis.setEx(`market:latest:${bar.ticker}`, 120, JSON.stringify(bar));
        }

        pollStats.lastPollTs   = Date.now();
        pollStats.lastBarCount = downsampled.length;
        pollStats.totalCycles++;
        console.log(`[market-data] persisted ${valid.length} 5m bars, published ${downsampled.length} ${targetInterval} bars (cycle ${pollStats.totalCycles})`);
      }
    } catch (e) {
      console.error('[market-data] poll error:', e);
    }

    // Wall-clock alignment: sleep until the next aligned tick rather than for a
    // fixed pollIntervalMs. Eliminates drift across pod restarts — polls always land
    // on the same wall-clock minutes regardless of when the pod started.
    const sleepMs = msUntilNextTick(pollIntervalMs, POLL_ANCHOR_OFFSET_MS);
    console.log(`[market-data] next poll in ${(sleepMs / 1000).toFixed(0)}s at ${new Date(Date.now() + sleepMs).toISOString()}`);
    await Bun.sleep(sleepMs);
  }
}

// Poll stats updated each cycle for /health visibility
const pollStats = { lastPollTs: null as number | null, lastBarCount: 0, totalCycles: 0 };

app.get('/health', async (c) => {
  const cfg = await getLiveConfig().catch(() => ({ barFrequency: 'daily', pollIntervalMs: INITIAL_POLL_MS }));
  // Compute the wall-clock-aligned next-poll timestamp so the portal can show a
  // countdown without having to know about POLL_ANCHOR_OFFSET_MS. Same helper the
  // pollLoop uses, so the answer reflects what'll actually fire.
  const nextPollTs = Date.now() + msUntilNextTick(cfg.pollIntervalMs, POLL_ANCHOR_OFFSET_MS);
  return c.json({
    status:         'ok',
    bar_frequency:  cfg.barFrequency,
    poll_interval_ms: cfg.pollIntervalMs,
    universe_size:  universeManager.activeTickers.length,
    last_poll_ts:   pollStats.lastPollTs,
    last_bar_count: pollStats.lastBarCount,
    total_cycles:   pollStats.totalCycles,
    next_poll_ts:   nextPollTs,
  });
});

app.route('/', createAdminRouter(universeManager, provider));
app.route('/', createInternalBarsRouter());

app.get('/latest/:ticker', async (c) => {
  const redis = await getRedisClient();
  const raw = await redis.get(`market:latest:${c.req.param('ticker')}`);
  return raw ? c.json(JSON.parse(raw)) : c.json({ error: 'not found' }, 404);
});

// Bootstrap sequence:
//   1. Ensure the unique compound index on ohlcv_bars exists.
//   2. Resolve the active universe so we know which tickers need history.
//   3. For any ticker missing 5m history in Mongo, run a one-shot backfill from the
//      provider (60-day window, idempotent on subsequent boots — once a ticker has any
//      5m bars cached, bootstrap skips it).
//   4. Start the live-poll loop.
//
// Boot is best-effort: a backfill failure (Yahoo down, ticker unresolvable) is logged
// per ticker but never blocks the live-poll from starting. Operator can re-run the
// admin backfill endpoint after the fact.
async function bootstrap(): Promise<void> {
  await ensureBarIndexes();

  let universe: string[] = [];
  try {
    universe = await universeManager.refresh();
  } catch (err) {
    console.warn('[market-data] universe refresh failed during bootstrap, skipping backfill:', err);
  }
  if (universe.length === 0) {
    universe = (process.env.TICKER_UNIVERSE ?? '').split(',').filter(Boolean);
  }

  if (universe.length > 0) {
    try {
      const db = await getMongoDb();
      const missing = await tickersMissingHistory(db, universe);
      if (missing.length > 0) {
        console.log(`[market-data] bootstrap: ${missing.length}/${universe.length} tickers have no 5m history — backfilling`);
        const redis = await getRedisClient();
        const results = await backfillTickers(db, redis, provider, missing);
        const ok    = results.filter((r) => !r.error).length;
        const total = results.reduce((acc, r) => acc + r.upserted, 0);
        const fail  = results.filter((r) => r.error).length;
        console.log(`[market-data] bootstrap backfill complete: ${ok}/${results.length} tickers OK, ${total} bars upserted, ${fail} failures`);
      } else {
        console.log(`[market-data] bootstrap: all ${universe.length} tickers have history — skipping backfill`);
      }
    } catch (err) {
      console.warn('[market-data] bootstrap backfill failed:', err);
    }
  }

  pollLoop().catch((err) => {
    console.error('[fatal]', err);
    process.exit(1);
  });
}

// Only run side-effecting boot when this file is the entrypoint. Tests import helpers
// like `latestPerTicker` from this module — running bootstrap then would trigger
// real Yahoo + Mongo I/O at module-load time.
if (import.meta.main) {
  bootstrap();
}

export default { port: 3002, fetch: app.fetch };
