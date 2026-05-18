import { setTimeout as sleep } from 'node:timers/promises';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
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
import { FxClient, YahooFxProvider } from '@trader/shared-fx';
import { aggregateBars } from '@trader/shared-bars';
import {
  HolidayCache, NyseIcalProvider, UkGovBankHolidayProvider, StaticFallbackProvider, STATIC_FALLBACK,
  nyseCalendar, lseCalendar, marketStateOf, shouldPollMarket, partitionByMarket,
  soonestNextOpen, expectedLatestBarMs,
  type Market, type MarketState, type ExchangeCalendar,
} from '@trader/shared-calendar';
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
const universeManager = new UniverseManager(async (amount, currency) => {
  const fx = await getFxClient();
  return fx.toGBP({ amount, currency });
});

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
    const last = aggregated[aggregated.length - 1];
    if (last) out.push(last);
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

// FxClient: lazy-singleton, shared across the service. Backed by Yahoo GBPUSD=X with
// 1h hot cache + 24h stale-fallback. Used here for liquidity ranking and (transitively
// via the provider) anywhere ADV needs to be expressed in BASE_CURRENCY.
let _fxClient: FxClient | null = null;
async function getFxClient(): Promise<FxClient> {
  if (_fxClient) return _fxClient;
  const redis = await getRedisClient();
  _fxClient = new FxClient(redis as any, new YahooFxProvider());
  return _fxClient;
}

// Provider is swappable: pass a different MarketDataProvider here once a paid feed
// or broker-native source is wired. The pollLoop / admin-routes / universe-manager
// all consume the abstraction, never Yahoo-specific functions directly.
const provider = new YahooProvider(async (amount, currency) => {
  const fx = await getFxClient();
  return fx.toGBP({ amount, currency });
});

// Calendar wiring: one HolidayCache per process, shared by both ExchangeCalendars.
// Hydrated in bootstrap() before pollLoop starts. The cache walks
// mem → Mongo → live providers (NYSE iCal, gov.uk JSON) → static fallback;
// failures degrade loudly rather than substituting wrong data.
let _holidayCache: HolidayCache | null = null;
let _nyseCal: ExchangeCalendar | null = null;
let _lseCal:  ExchangeCalendar | null = null;
async function getHolidayCache(): Promise<HolidayCache> {
  if (_holidayCache) return _holidayCache;
  const db = await getMongoDb();
  _holidayCache = new HolidayCache(
    db,
    { US: new NyseIcalProvider(), LSE: new UkGovBankHolidayProvider() },
    STATIC_FALLBACK,
  );
  return _holidayCache;
}
function calendarFor(market: Market): ExchangeCalendar {
  if (market === 'US')  return _nyseCal ?? (() => { throw new Error('calendar not yet bootstrapped'); })();
  if (market === 'LSE') return _lseCal  ?? (() => { throw new Error('calendar not yet bootstrapped'); })();
  throw new Error(`calendarFor: unsupported market ${market}`);
}

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

    // Session gate. Partition the universe by exchange and decide, per-market,
    // whether to fetch this cycle. Markets in REGULAR/PRE/POST poll; CLOSED skips.
    // When all relevant markets skip, the cycle is a no-op (log + sleep), saving
    // ~30% of weekly Yahoo calls on weekends + ~10h/weekday of asymmetric closures.
    const groups = partitionByMarket(activeTickers);
    type Decision = { market: Market; tickers: string[]; state: MarketState };
    const decisions: Decision[] = [];
    for (const m of ['US', 'LSE'] as Market[]) {
      if (groups[m].length === 0) continue;
      decisions.push({ market: m, tickers: groups[m], state: await marketStateOf(calendarFor(m), Date.now()) });
    }
    const activeDecisions = decisions.filter((d) => d.state === 'REGULAR' || d.state === 'POST' || d.state === 'PRE');

    if (activeDecisions.length === 0) {
      const summary = decisions.map((d) => `${d.market}=${d.state}`).join(', ');
      let nextOpenIso = 'unknown';
      try {
        const next = await soonestNextOpen(decisions.map((d) => calendarFor(d.market)), Date.now());
        nextOpenIso = new Date(next).toISOString();
      } catch { /* calendar exhaustion — surfaced separately on /health */ }
      console.log(`[market-data] session gate skip — ${summary || 'no recognised markets'}; next open ${nextOpenIso}`);
      pollStats.gateSkipsTotal++;
      pollStats.lastGateSkipTs = Date.now();
      const sleepMs = msUntilNextTick(pollIntervalMs, POLL_ANCHOR_OFFSET_MS);
      console.log(`[market-data] next poll in ${(sleepMs / 1000).toFixed(0)}s at ${new Date(Date.now() + sleepMs).toISOString()}`);
      await sleep(sleepMs);
      continue;
    }

    // For each open partition, run the existing pipeline scoped to that market's
    // tickers. The heal pass is session-aware: `expectedLatestMs = most-recent
    // session close` suppresses Monday-morning false-positives for tickers whose
    // latest bar IS Friday's close (nothing actually missing — market was just shut).
    for (const decision of activeDecisions) {
      try {
        const cal = calendarFor(decision.market);
        const expectedLatestMs = (await expectedLatestBarMs(cal, Date.now())) ?? undefined;

        try {
          const db = await getMongoDb();
          const redis2 = await getRedisClient();
          const heal = await healMissingHistory(db, redis2, provider, decision.tickers, expectedLatestMs !== undefined ? { expectedLatestMs } : {});
          if (heal.healed > 0) {
            console.warn(`[market-data] heal (${decision.market}): ${heal.healed} ticker(s), ${heal.barsAdded} bars filled, ${heal.unrecoverable} unrecoverable`);
          }
        } catch (err) {
          console.warn(`[market-data] heal pass failed for ${decision.market} (non-fatal):`, err);
        }

        const rawBars = await provider.fetchRecent(decision.tickers, 24);
        const { valid, invalid } = validator.validate(rawBars);

        if (invalid.length > 0) {
          const db = await getMongoDb();
          await db.collection(COLLECTIONS.BAD_TICKS).insertMany(
            invalid.map(({ bar, reason }) => ({ ...bar, reason, loggedAt: new Date() })),
          );
          console.warn(`[market-data] ${invalid.length} bad ticks rejected (${decision.market})`);
        }

        // Gap detection scoped to the partition — a US-only window shouldn't trip
        // the gap alarm on LSE tickers we deliberately didn't fetch.
        const representedTickers = new Set(valid.map((b) => b.ticker));
        const gapReport = gapDetector.check(
          decision.tickers,
          decision.tickers.filter((t) => representedTickers.has(t)).map((t) => ({ ticker: t } as OHLCVBar)),
        );
        if (gapReport.gapFraction > GAP_THRESHOLD) {
          const db = await getMongoDb();
          await db.collection(COLLECTIONS.BAD_TICKS).insertOne({
            type: 'universe_gap',
            market: decision.market,
            missingTickers: gapReport.missingTickers,
            gapFraction: gapReport.gapFraction,
            timestamp: Date.now(),
            loggedAt: new Date(),
          });
          console.warn(`[market-data] ${(gapReport.gapFraction * 100).toFixed(0)}% of ${decision.market} missing — skipping publish`);
          continue;
        }

        if (valid.length > 0) {
          await persistBars(valid, '5m');
          const targetInterval: BarInterval = cfg.barFrequency === 'intraday' ? '15m' : 'daily';
          const downsampled = latestPerTicker(valid, targetInterval);
          await xAdd(redis, REDIS_STREAMS.MARKET_RAW, downsampled);
          for (const bar of downsampled) {
            await redis.setEx(`market:latest:${bar.ticker}`, 120, JSON.stringify(bar));
          }
          pollStats.lastPollTs   = Date.now();
          pollStats.lastBarCount = downsampled.length;
          pollStats.totalCycles++;
          console.log(`[market-data] ${decision.market}: ${valid.length} 5m bars, ${downsampled.length} ${targetInterval} bars (cycle ${pollStats.totalCycles})`);
        }
      } catch (e) {
        console.error(`[market-data] poll error (${decision.market}):`, e);
      }
    }

    // Wall-clock alignment: sleep until the next aligned tick rather than for a
    // fixed pollIntervalMs. Eliminates drift across pod restarts — polls always land
    // on the same wall-clock minutes regardless of when the pod started.
    const sleepMs = msUntilNextTick(pollIntervalMs, POLL_ANCHOR_OFFSET_MS);
    console.log(`[market-data] next poll in ${(sleepMs / 1000).toFixed(0)}s at ${new Date(Date.now() + sleepMs).toISOString()}`);
    await sleep(sleepMs);
  }
}

// Poll stats updated each cycle for /health visibility.
// gateSkipsTotal counts full-cycle skips where all relevant markets are closed; it's
// what powers the portal's "Yahoo calls saved" tile against totalCycles.
const pollStats = {
  lastPollTs:      null as number | null,
  lastBarCount:    0,
  totalCycles:     0,
  gateSkipsTotal:  0,
  lastGateSkipTs:  null as number | null,
};

app.get('/health', async (c) => {
  const cfg = await getLiveConfig().catch(() => ({ barFrequency: 'daily', pollIntervalMs: INITIAL_POLL_MS }));
  const nextPollTs = Date.now() + msUntilNextTick(cfg.pollIntervalMs, POLL_ANCHOR_OFFSET_MS);

  // Session-aware surface. Best-effort: if the calendars aren't yet bootstrapped
  // (very early in the lifecycle) we return what we have rather than 500.
  const session_states: Partial<Record<Market, MarketState>> = {};
  let next_session_open_ts: number | null = null;
  let session_gate_skipping = false;
  let holiday_source_health: any[] = [];
  try {
    const universeMarkets = ['US', 'LSE'] as Market[];
    const states = await Promise.all(universeMarkets.map(async (m) => [m, await marketStateOf(calendarFor(m), Date.now())] as const));
    let anyPollable = false;
    for (const [m, s] of states) {
      session_states[m] = s;
      if (s === 'REGULAR' || s === 'PRE' || s === 'POST') anyPollable = true;
    }
    session_gate_skipping = !anyPollable;
    if (session_gate_skipping) {
      try {
        next_session_open_ts = await soonestNextOpen([calendarFor('US'), calendarFor('LSE')], Date.now());
      } catch { /* calendar exhaustion — surfaced via holiday_source_health below */ }
    }
    const cache = await getHolidayCache();
    holiday_source_health = await cache.getSourceHealth();
  } catch { /* calendars not bootstrapped yet — return blank session fields */ }

  return c.json({
    status:                'ok',
    bar_frequency:         cfg.barFrequency,
    poll_interval_ms:      cfg.pollIntervalMs,
    universe_size:         universeManager.activeTickers.length,
    last_poll_ts:          pollStats.lastPollTs,
    last_bar_count:        pollStats.lastBarCount,
    total_cycles:          pollStats.totalCycles,
    next_poll_ts:          nextPollTs,
    session_states,
    session_gate_skipping,
    next_session_open_ts,
    gate_skips_total:      pollStats.gateSkipsTotal,
    last_gate_skip_ts:     pollStats.lastGateSkipTs,
    holiday_source_health,
  });
});

// Lightweight console-backed logger shim; market-data-service still runs from index.ts
// at module scope. Pino-backed logger is wired in src/main.ts and threaded down when the
// service is migrated to the modules/ shape.
const adminLogger = {
  info:  (..._args: unknown[]) => { /* swallowed; market-data is verbose in dev */ },
  warn:  (...args: unknown[]) => console.warn('[market-data]', ...args),
  error: (...args: unknown[]) => console.error('[market-data]', ...args),
  debug: () => {}, trace: () => {}, fatal: (...args: unknown[]) => console.error('[market-data]', ...args),
  child: () => adminLogger, level: 'info',
} as unknown as Parameters<typeof createAdminRouter>[2];

app.route('/', createAdminRouter(universeManager, provider, adminLogger, {
  holidayCache: () => _holidayCache ?? (() => { throw new Error('holiday cache not bootstrapped'); })(),
  calendarFor,
}));
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

  // Holiday cache + per-exchange calendars. Hydrate eagerly so pollLoop's first
  // gate decision doesn't pay a cold-cache provider hit. Background refresh
  // keeps the Mongo cache fresh weekly thereafter.
  const cache = await getHolidayCache();
  _nyseCal = nyseCalendar(cache);
  _lseCal  = lseCalendar(cache);
  try {
    const year = new Date().getUTCFullYear();
    await Promise.all([
      cache.getTable('US',  year),
      cache.getTable('LSE', year),
    ]);
    console.log('[market-data] holiday calendars hydrated');
  } catch (err) {
    console.warn('[market-data] holiday hydration failed (will retry on first poll):', err);
  }
  cache.startBackgroundRefresh();

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

// Bootstrap runs unconditionally for prod runtime (node dist/main.js). Tests import
// helpers from this module via vitest's module loader, which uses a separate process.
bootstrap();

const port = Number(process.env.PORT ?? 3002);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[market-data-service] listening on :${info.port}`);
});
