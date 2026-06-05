import { setTimeout as sleep } from 'node:timers/promises';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { mountMetrics } from '@trader/core';
import { getRedisClient, xAdd, ensureConsumerGroup } from '@trader/shared-redis';
import { getMongoDb } from '@trader/shared-mongo';
import { COLLECTIONS } from '@trader/shared-mongo';
import { BarValidator } from './modules/bars/infrastructure/bar-validator.ts';
import { GapDetector } from './modules/bars/infrastructure/gap-detector.ts';
import { StaleDetector } from './modules/bars/infrastructure/stale-detector.ts';
import { UniverseManager } from './modules/universe/application/UniverseManager.ts';
import { getPgPool } from '@trader/shared-pg';
import { QuotePoll } from './modules/quotes/application/quote-poll.ts';
import { QuoteWriter } from './modules/quotes/infrastructure/quote-writer.ts';
import { buildQuoteProvider } from './modules/quotes/infrastructure/quote-providers.ts';
import { getLiveConfig } from './shared/live-config.ts';
import { createAdminRouter, createInternalBarsRouter } from './modules/admin/routes.ts';
import { YahooProvider } from './modules/bars/infrastructure/providers/yahoo-provider.ts';
import { TwelveDataProvider } from './modules/bars/infrastructure/providers/twelvedata-provider.ts';
import { configureEodhdClient } from './modules/bars/infrastructure/providers/eodhd-client.ts';
import type { MarketDataProvider } from './modules/bars/infrastructure/providers/market-data-provider.ts';
import { FxClient, YahooFxProvider } from '@trader/shared-fx';
import { aggregateBars, invalidateBarsBulk } from '@trader/shared-bars';
import {
  HolidayCache, NyseIcalProvider, UkGovBankHolidayProvider, StaticFallbackProvider, STATIC_FALLBACK,
  nyseCalendar, lseCalendar, marketStateOf, shouldPollMarket, partitionByMarket,
  soonestNextOpen, expectedLatestBarMs, soonestEodPollInstant,
  type Market, type MarketState, type ExchangeCalendar,
} from '@trader/shared-calendar';
import { backfillTickers, tickersMissingHistory, healMissingHistory } from './modules/bars/infrastructure/backfill.ts';
import { backfillDailyHistory, tickersMissingDailyHistory } from './modules/bars/infrastructure/daily-history.ts';
import { runEodhdDailyFeed } from './modules/bars/infrastructure/eodhd-daily-feed.ts';
import { buildFundamentalsCache } from './modules/fundamentals/wiring.ts';
import { FundamentalsRefreshScheduler } from './modules/fundamentals/application/FundamentalsRefreshScheduler.ts';
import { createFundamentalsRouter } from './modules/fundamentals/routes.ts';
import { createScannerRouter } from './modules/scanner/routes.ts';
import { writeBarRevisions, ensureBiTemporalIndexes, fetchFirstPrintCloses } from './modules/bars/infrastructure/persist-bars.ts';
import { msUntilNextTick } from './modules/bars/application/poll-scheduling.ts';
import { log } from './logger.ts';
import { getRuntimeEnv } from './runtime-env.ts';
import { REDIS_STREAMS, type OHLCVBar, type BarInterval, type Currency } from '@trader/shared-types';

const env = getRuntimeEnv();

// Wall-clock anchor for the poll grid. 24h ticks land at this UTC offset (~1h after
// US close = 22:00 UTC); shorter intervals land at the same phase.
const POLL_ANCHOR_OFFSET_MS = env.POLL_ANCHOR_OFFSET_MS;

// Daily (EOD) cadence: how long after a market's close to wake and fetch its
// just-completed session. Must be > the upstream EOD-print settle window (Yahoo's
// late 5m bar lands within ~60min; TwelveData is immediate) and ≤ the 90min
// post-close grace so the market is still POST when we emit the daily bar.
const EOD_POLL_DELAY_MS = 65 * 60_000;

const app = new Hono();
// BAR_FREQUENCY=daily   → re-poll Yahoo every POLL_INTERVAL_MS (default 20m) until the
//                        EOD adjusted bar arrives; the cycle then idles until next close.
// BAR_FREQUENCY=intraday → poll at POLL_INTERVAL_MS (default 60s).
//
// Effective values are resolved per poll-iteration via getLiveConfig() so portal
// overrides (portal_market_config) take effect without a service restart.
// Env values are used as the fallback when no override is set.

// Universe refresh cadence: monthly in production; override via env for testing
const UNIVERSE_REFRESH_MS = env.UNIVERSE_REFRESH_MS;
// Gap threshold: skip cycle if more than this fraction of universe is missing.
const GAP_THRESHOLD = env.GAP_THRESHOLD;

const validator  = new BarValidator();
// Gap/stale detectors are initialized with the env-default poll interval; their
// thresholds aren't latency-critical so live-config changes don't need to rewire them.
const INITIAL_POLL_MS = env.POLL_INTERVAL_MS ?? (env.BAR_FREQUENCY === 'daily' ? 20 * 60 * 1000 : 60 * 1000);
const gapDetector = new GapDetector(INITIAL_POLL_MS);
const staleDetector = new StaleDetector(INITIAL_POLL_MS * 3);
// Parse the comma-separated include lists from env. Without this, UniverseManager
// silently falls through to the legacy "first N from T212" path which admits every
// instrument T212 carries — Xetra, Lisbon, Madrid, etc. — and the active universe
// ends up dominated by OTHER-bucket tickers our session-gate ignores.
const parseSymbolList = (s: string): string[] =>
  s.split(',').map((t) => t.trim()).filter(Boolean);

const universeManager = new UniverseManager(
  async (amount, currency) => {
    const fx = await getFxClient();
    return fx.toGBP({ amount, currency });
  },
  {
    maxSize:     env.UNIVERSE_MAX_SIZE,
    includeUs:   parseSymbolList(env.UNIVERSE_INCLUDE_US),
    includeLse:  parseSymbolList(env.UNIVERSE_INCLUDE_LSE),
    minPriceGbp: env.UNIVERSE_MIN_PRICE,
    minAdvGbp:   env.UNIVERSE_MIN_ADV,
    source:      env.UNIVERSE_SOURCE,
    minCapGbp:   env.MIN_MARKET_CAP_GBP,
  },
);

// Bi-temporal persist. Cosmetic re-polls (same content hash as the latest stored
// revision) are no-ops; genuine revisions atomically supersede the prior row and
// append a new one (plus a bar_revisions_log audit entry) in one transaction.
// See agent-docs/plans/point-in-time-bar-history.md and persist-bars.ts.
async function persistBars(bars: OHLCVBar[], interval: BarInterval): Promise<void> {
  if (bars.length === 0) return;
  const db = await getMongoDb();
  const stats = await writeBarRevisions(db, bars, interval);
  // Surface non-zero revision activity at info — a stable system emits zero per cycle.
  // Steady-state cycles (all cosmetic skips) don't log at all to keep volume sane.
  if (stats.revisions > 0 || stats.inserted !== stats.attempted - stats.skipped) {
    log.info(`[market-data] persist ${interval}: attempted=${stats.attempted} inserted=${stats.inserted} revisions=${stats.revisions} skipped=${stats.skipped}`);
  }
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

// Daily session-close emit. Fires once per (market, UTC-date) when the market reaches
// CLOSED, putting one rolled-up daily bar per ticker on market:raw:daily. Gated by a
// Redis NX-set with 25h TTL so:
//   • two pollLoop pods (future HA) can't double-emit
//   • a pod restart after the close doesn't re-fire the same date
//   • the gate naturally rolls over for the next day after >24h idle
// We aggregate today's persisted 5m bars (UTC-day fold) — by the time state==CLOSED, the
// session's final 5m bars have already been persisted by the regular poll path.
async function maybeEmitDailyAtClose(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  groups: { US: string[]; LSE: string[] },
  cycleCounter: number,
  emitStates: readonly MarketState[] = ['CLOSED'],
): Promise<void> {
  const utcDate = new Date().toISOString().slice(0, 10);          // YYYY-MM-DD (UTC)
  const utcMidnightMs = Date.parse(`${utcDate}T00:00:00.000Z`);

  for (const market of ['US', 'LSE'] as Market[]) {
    const tickers = groups[market];
    if (tickers.length === 0) continue;

    const state = await marketStateOf(calendarFor(market), Date.now());
    if (!emitStates.includes(state)) continue;

    const gateKey = `market-data:daily-emit:${market}:${utcDate}`;
    const acquired = await redis.set(gateKey, '1', { NX: true, EX: 25 * 60 * 60 });
    if (!acquired) continue;       // already emitted this UTC date for this market

    try {
      const db = await getMongoDb();
      // Read the latest unsuperseded 5m bars for the UTC day. is_superseded:false
      // picks one row per (ticker, observation_ts) via the partial-unique index;
      // observation_ts:$gte bounds the day.
      const docs = await db.collection(COLLECTIONS.OHLCV_BARS)
        .find({
          ticker:         { $in: tickers },
          interval:       '5m',
          is_superseded:  false,
          observation_ts: { $gte: utcMidnightMs },
        })
        .toArray();
      if (docs.length === 0) {
        log.warn(`[market-data] daily-emit ${market} ${utcDate}: no 5m bars found — skipping`);
        continue;
      }
      // Group by ticker then aggregate-to-daily so aggregateBars sees one ticker's bars
      // at a time (it folds all rows into a single output bar keyed by the head ticker).
      const byTicker = new Map<string, OHLCVBar[]>();
      for (const d of docs) {
        const obsTs = typeof d.observation_ts === 'number'
          ? d.observation_ts
          : (d.timestamp instanceof Date ? d.timestamp.getTime() : Number(d.timestamp ?? 0));
        const bar: OHLCVBar = {
          ticker:         d.ticker as string,
          observation_ts: obsTs,
          timestamp:      obsTs,
          interval:       '5m',
          open:           d.open as number,
          high:           d.high as number,
          low:            d.low as number,
          close:          d.close as number,
          volume:         d.volume as number,
        };
        let list = byTicker.get(bar.ticker);
        if (!list) { list = []; byTicker.set(bar.ticker, list); }
        list.push(bar);
      }
      const dailyBars: OHLCVBar[] = [];
      for (const list of byTicker.values()) {
        const agg = aggregateBars(list, 'daily');
        const last = agg[agg.length - 1];
        if (last) dailyBars.push(last);
      }
      if (dailyBars.length === 0) {
        log.warn(`[market-data] daily-emit ${market} ${utcDate}: aggregation produced 0 bars`);
        continue;
      }
      await persistBars(dailyBars, 'daily');
      // Drop the daily read-cache so the next getBars('daily', …) reflects today's close.
      await invalidateBarsBulk(redis as any, dailyBars.map((b) => ({ ticker: b.ticker, interval: 'daily' as BarInterval })));
      await xAdd(redis, REDIS_STREAMS.MARKET_RAW_DAILY, dailyBars);
      log.info(`[market-data] daily-emit ${market} ${utcDate} cycle=${cycleCounter}: ${dailyBars.length} bars → market:raw:daily`);
    } catch (err) {
      // Release the gate on failure so the next cycle retries. Without this, a transient
      // Mongo blip would silently skip the daily emit for the entire day.
      await redis.del(gateKey).catch(() => {});
      log.error(`[market-data] daily-emit ${market} ${utcDate} failed — gate released for retry:`, err);
    }
  }
}

// Bi-temporal indexes. Boot-time idempotent setup. Drops the legacy unique index
// `ticker_timestamp_interval_unique` (new writes don't set `timestamp`; the old
// index would collide every insert on null), creates the compound + partial-unique
// + knowledge-time triple required by the new read/write paths.
//
// Sees ohlcv_bars existing as a time-series collection as fatal — Mongo refuses
// unique indexes on those, and there's no in-place migration. Operator must drop
// and recreate as a regular collection.
async function ensureBarIndexes(): Promise<void> {
  const db = await getMongoDb();
  try {
    await ensureBiTemporalIndexes(db);
  } catch (err) {
    if (err instanceof Error && err.message.includes('time-series')) {
      process.exit(1);
    }
    log.warn('[market-data] ensure bi-temporal indexes failed (non-fatal):', err);
  }
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

// Provider is swappable via MARKET_DATA_PROVIDER (default `twelvedata`; `yahoo` is the
// legacy fallback). The pollLoop / admin-routes / universe-manager all consume the
// MarketDataProvider abstraction, never provider-specific functions directly — so flipping
// the env var (and redeploying) is the only change needed to roll back to Yahoo.
function buildProvider(): MarketDataProvider {
  const fxToGBP = async (amount: number, currency: Currency) => {
    const fx = await getFxClient();
    return fx.toGBP({ amount, currency });
  };
  if (env.MARKET_DATA_PROVIDER === 'yahoo') {
    log.info('[market-data] provider = yahoo (free Yahoo Finance)');
    return new YahooProvider(fxToGBP);
  }
  if (!env.TWELVEDATA_API_KEY) {
    log.error('[market-data] MARKET_DATA_PROVIDER=twelvedata but TWELVEDATA_API_KEY is unset — provider will return no bars until the secret is wired');
  }
  log.info(`[market-data] provider = twelvedata (${env.TWELVEDATA_CREDITS_PER_MIN} credits/min, ${env.TWELVEDATA_DAILY_CREDIT_LIMIT}/day budget)`);
  return new TwelveDataProvider(
    {
      apiKey:           env.TWELVEDATA_API_KEY ?? '',
      creditsPerMinute: env.TWELVEDATA_CREDITS_PER_MIN,
      dailyCreditLimit: env.TWELVEDATA_DAILY_CREDIT_LIMIT,
    },
    fxToGBP,
  );
}
const provider: MarketDataProvider = buildProvider();

// EODHD client (daily/EOD + screener) — configured once at boot so the daily-history dispatch
// (DAILY_HISTORY_PROVIDER=eodhd) and the universe scanner share one budgeted client. Intraday
// OHLCV stays on `provider` (TwelveData); EODHD is a separate daily/universe upstream.
configureEodhdClient({
  apiKey:         env.EODHD_API_KEY ?? '',
  callsPerMinute: env.EODHD_CALLS_PER_MIN,
  dailyCallLimit: env.EODHD_DAILY_CALL_LIMIT,
});
if (env.DAILY_HISTORY_PROVIDER === 'eodhd' && !env.EODHD_API_KEY) {
  log.warn('[market-data] DAILY_HISTORY_PROVIDER=eodhd but EODHD_API_KEY is unset — daily history will be empty until the secret is wired');
}

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
  log.info('[market-data] poll-loop: refreshing universe at startup');
  let activeTickers = await universeManager.refresh();
  if (activeTickers.length === 0) {
    // Fallback to env var seed list if registry is empty
    activeTickers = (env.TICKER_UNIVERSE ?? 'AAPL_US_EQ,MSFT_US_EQ,GOOGL_US_EQ,AMZN_US_EQ,NVDA_US_EQ,TSLA_US_EQ,FB_US_EQ,NFLX_US_EQ,AMD_US_EQ,INTC_US_EQ').split(',');
    log.warn(`[market-data] universe empty — using TICKER_UNIVERSE env: ${activeTickers.join(',')}`);
  } else {
    log.info(`[market-data] active universe: ${activeTickers.length} tickers`);
  }
  let lastUniverseRefresh = Date.now();
  let cycleCounter = 0;

  while (true) {
    cycleCounter++;
    const cycleStartMs = Date.now();
    const cfg = await getLiveConfig();
    const pollIntervalMs = cfg.pollIntervalMs;
    log.info(`[market-data] ── cycle ${cycleCounter} start @ ${new Date(cycleStartMs).toISOString()} | bar_frequency=${cfg.barFrequency} poll_interval=${(pollIntervalMs / 1000).toFixed(0)}s | universe=${activeTickers.length}`);

    // Monthly universe refresh
    if (Date.now() - lastUniverseRefresh > UNIVERSE_REFRESH_MS) {
      log.info('[market-data] universe refresh due');
      activeTickers = await universeManager.refresh();
      lastUniverseRefresh = Date.now();
      log.info(`[market-data] universe refreshed: ${activeTickers.length} tickers`);
    }

    // EODHD bulk daily feed — refresh the persisted daily series for the active universe.
    // Self-gated per (exchange, UTC date) so it costs ~2 EODHD calls/day; only runs when EODHD
    // is the daily source (the EODHD-scanned universe is too large for TwelveData intraday).
    if (env.DAILY_HISTORY_PROVIDER === 'eodhd' && cfg.barFrequency === 'daily') {
      try {
        await runEodhdDailyFeed(await getMongoDb(), redis, activeTickers);
      } catch (err) {
        log.warn('[market-data] EODHD daily feed failed (continuing):', err);
      }
    }

    // Session gate. Partition the universe by exchange and decide, per-market,
    // whether to fetch this cycle. Markets in REGULAR/PRE/POST poll; CLOSED skips.
    // When all relevant markets skip, the cycle is a no-op (log + sleep), saving
    // ~30% of weekly Yahoo calls on weekends + ~10h/weekday of asymmetric closures.
    const groups = partitionByMarket(activeTickers);
    log.info(`[market-data] partition: US=${groups.US.length} LSE=${groups.LSE.length} OTHER=${groups.OTHER.length}`);
    if (groups.OTHER.length > 0) {
      log.warn(`[market-data] ${groups.OTHER.length} ticker(s) in OTHER bucket — not pollable. Sample: ${groups.OTHER.slice(0, 10).join(',')}`);
    }
    type Decision = { market: Market; tickers: string[]; state: MarketState };
    // BAR_FREQUENCY drives two distinct polling shapes:
    //   • daily (EOD) — poll each market exactly once, ~EOD_POLL_DELAY_MS into its own
    //     post-close window, and fetch only that market's just-completed session. A
    //     single shared UTC anchor can't serve both markets (no instant has both LSE
    //     and NYSE freshly closed), so the loop wakes per-market off each calendar.
    //   • intraday — the original session gate: poll every market in REGULAR/PRE/POST.
    const isEod = cfg.barFrequency === 'daily';
    let activeDecisions: Decision[] = [];

    if (isEod) {
      for (const m of ['US', 'LSE'] as Market[]) {
        if (groups[m].length === 0) continue;
        const cal = calendarFor(m);
        const state = await marketStateOf(cal, Date.now());
        const recentCloseMs = await expectedLatestBarMs(cal, Date.now());
        if (recentCloseMs == null) {
          log.info(`[market-data] ${m} session=${state} — no recent session close found, skipping EOD poll`);
          continue;
        }
        const elapsedMin = (Date.now() - recentCloseMs) / 60_000;
        // Wait until the close has settled. We wake at close+delay, so this only trips
        // when the loop arrives early (boot mid-POST, clock slip).
        if (Date.now() - recentCloseMs < EOD_POLL_DELAY_MS - 60_000) {
          log.info(`[market-data] ${m} session=${state} — last close ${elapsedMin.toFixed(0)}min ago (< ${(EOD_POLL_DELAY_MS / 60_000).toFixed(0)}min EOD delay), waiting`);
          continue;
        }
        // Idempotent per (market, session-date): survives pod restarts and timing slips,
        // and stops the same session being fetched twice (which would burn TD credits).
        const sessionDate = new Date(recentCloseMs).toISOString().slice(0, 10);
        const gateKey = `market-data:eod-poll:${m}:${sessionDate}`;
        const acquired = await redis.set(gateKey, '1', { NX: true, EX: 25 * 60 * 60 });
        if (!acquired) {
          log.info(`[market-data] ${m} session ${sessionDate} already polled (state=${state}) — skipping`);
          continue;
        }
        activeDecisions.push({ market: m, tickers: groups[m], state });
        log.info(`[market-data] ${m} EOD poll claimed for session ${sessionDate} (state=${state}, +${elapsedMin.toFixed(0)}min)`);
      }
    } else {
      const decisions: Decision[] = [];
      for (const m of ['US', 'LSE'] as Market[]) {
        if (groups[m].length === 0) continue;
        const state = await marketStateOf(calendarFor(m), Date.now());
        decisions.push({ market: m, tickers: groups[m], state });
        log.info(`[market-data] ${m} session=${state} (tickers=${groups[m].length})`);
      }
      activeDecisions = decisions.filter((d) => d.state === 'REGULAR' || d.state === 'POST' || d.state === 'PRE');
    }

    if (activeDecisions.length === 0) {
      pollStats.gateSkipsTotal++;
      pollStats.lastGateSkipTs = Date.now();
      log.info(`[market-data] no markets to poll this cycle (mode=${isEod ? 'eod' : 'intraday'})`);
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
          const healStart = Date.now();
          const heal = await healMissingHistory(db, redis2, provider, decision.tickers, expectedLatestMs !== undefined ? { expectedLatestMs } : {});
          log.info(`[market-data] heal (${decision.market}) checked ${decision.tickers.length} tickers in ${Date.now() - healStart}ms — healed=${heal.healed} barsAdded=${heal.barsAdded} unrecoverable=${heal.unrecoverable}`);
        } catch (err) {
          log.warn(`[market-data] heal pass failed for ${decision.market} (non-fatal):`, err);
        }

        const fetchStart = Date.now();
        log.info(`[market-data] ${decision.market} fetchRecent: requesting 24h window for ${decision.tickers.length} tickers`);
        const rawBars = await provider.fetchRecent(decision.tickers, 24);
        const fetchMs = Date.now() - fetchStart;
        // First-print isolation: batch-fetch the earliest knowledge_ts close per
        // (ticker, observation_ts) so the validator can identify revisions (and refuse
        // to let them perturb its rolling z-score window). Cheap aggregation, hits the
        // (ticker, observation_ts, interval, knowledge_ts) index for the match + group.
        const db = await getMongoDb();
        const firstPrintCloseByKey = await fetchFirstPrintCloses(db, rawBars, '5m');
        const { valid, invalid, revisionAnomalies } = validator.validate(rawBars, { firstPrintCloseByKey });
        log.info(`[market-data] ${decision.market} fetched ${rawBars.length} raw bars in ${fetchMs}ms — valid=${valid.length} invalid=${invalid.length} revision_anomalies=${revisionAnomalies.length}`);

        if (invalid.length > 0) {
          await db.collection(COLLECTIONS.BAD_TICKS).insertMany(
            invalid.map(({ bar, reason }) => ({ ...bar, reason, loggedAt: new Date() })),
          );
          log.warn(`[market-data] ${invalid.length} bad ticks rejected (${decision.market}) — sample reasons: ${invalid.slice(0, 3).map((i) => i.reason).join(' | ')}`);
        }

        if (revisionAnomalies.length > 0) {
          await db.collection(COLLECTIONS.BAD_TICKS).insertMany(
            revisionAnomalies.map(({ bar, firstPrintClose, driftFraction }) => ({
              type:            'revision_zscore_anomaly',
              ticker:          bar.ticker,
              observation_ts:  bar.observation_ts,
              revisedClose:    bar.close,
              firstPrintClose,
              driftFraction,
              loggedAt:        new Date(),
            })),
          );
          log.warn(`[market-data] ${revisionAnomalies.length} revision anomalies (${decision.market}) — sample: ${revisionAnomalies.slice(0, 3).map((a) => `${a.bar.ticker}@${a.bar.observation_ts}: ${(a.driftFraction * 100).toFixed(1)}% drift`).join(' | ')}`);
        }

        // Gap detection scoped to the partition — a US-only window shouldn't trip
        // the gap alarm on LSE tickers we deliberately didn't fetch.
        const representedTickers = new Set(valid.map((b) => b.ticker));
        const gapReport = gapDetector.check(
          decision.tickers,
          decision.tickers.filter((t) => representedTickers.has(t)).map((t) => ({ ticker: t } as OHLCVBar)),
        );
        log.info(`[market-data] ${decision.market} gap-check: ${representedTickers.size}/${decision.tickers.length} tickers represented (gap=${(gapReport.gapFraction * 100).toFixed(1)}% threshold=${(GAP_THRESHOLD * 100).toFixed(0)}%)`);
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
          log.warn(`[market-data] ${(gapReport.gapFraction * 100).toFixed(0)}% of ${decision.market} missing — SKIPPING publish. Missing sample: ${gapReport.missingTickers.slice(0, 10).join(',')}`);
          continue;
        }

        if (valid.length > 0) {
          const persistStart = Date.now();
          await persistBars(valid, '5m');
          // Invalidate the shared-bars Redis read-through cache for every ticker we
          // just wrote. Without this, a consumer (strategy-engine, dispatcher drift
          // gate, portal) that hit getBars() during a cache-miss BEFORE these bars
          // existed would have a 1h-TTL empty entry poisoning every read until expiry.
          // Observed in cluster as `ready=0/N` in strategy-engine despite live
          // persisted bars landing in Mongo on the same cycle.
          const writtenTickers = Array.from(new Set(valid.map((b) => b.ticker)));
          await invalidateBarsBulk(redis as any, writtenTickers.map((t) => ({ ticker: t, interval: '5m' as BarInterval })));
          const targetInterval: BarInterval = cfg.barFrequency === 'intraday' ? '15m' : 'daily';
          const downsampled = latestPerTicker(valid, targetInterval);
          await xAdd(redis, REDIS_STREAMS.MARKET_RAW, downsampled);

          // 5m stream — only fed in intraday cadence. Under daily/EOD cadence the provider
          // is polled once per session, so the "latest 5m bar" is a single daily-spaced
          // print: feeding it to the 5m worker (60-bar intraday window) produces mis-windowed
          // signals that just duplicate the daily worker on a 60-day lag. The daily worker
          // owns the daily bars via maybeEmitDailyAtClose → market:raw:daily. When the
          // platform flips to an intraday provider/cadence this resumes automatically.
          if (cfg.barFrequency === 'intraday') {
            const fivemBars = latestPerTicker(valid, '5m');
            await xAdd(redis, REDIS_STREAMS.MARKET_RAW_5M, fivemBars);
          }

          for (const bar of downsampled) {
            await redis.setEx(`market:latest:${bar.ticker}`, 120, JSON.stringify(bar));
          }
          pollStats.lastPollTs   = Date.now();
          pollStats.lastBarCount = downsampled.length;
          pollStats.totalCycles++;
          const fivemNote = cfg.barFrequency === 'intraday' ? ` + ${downsampled.length} 5m→market:raw:5m` : ' (5m stream skipped — daily cadence)';
          log.info(`[market-data] ${decision.market} persisted ${valid.length} 5m bars + invalidated ${writtenTickers.length} cache entries + xAdd ${downsampled.length} ${targetInterval}→market:raw${fivemNote} in ${Date.now() - persistStart}ms (totalCycles=${pollStats.totalCycles})`);
        } else {
          log.warn(`[market-data] ${decision.market}: no valid bars to persist this cycle`);
        }
      } catch (e) {
        log.error(`[market-data] poll error (${decision.market}):`, e);
      }
    }

    // Daily session-close emit. Runs every cycle (incl. no-poll cycles) so a market
    // that closed since the last cycle gets its rolled-up daily bar onto market:raw:daily.
    // In EOD mode we emit as soon as the market is POST (we just fetched its closed
    // session, +65min); intraday keeps the original CLOSED-only trigger. The internal
    // Redis NX gate dedupes per (market, UTC-date) either way. Placed AFTER the poll so
    // it reads the 5m bars this cycle persisted, not a stale snapshot.
    await maybeEmitDailyAtClose(redis, { US: groups.US, LSE: groups.LSE }, cycleCounter, isEod ? ['POST', 'CLOSED'] : ['CLOSED'])
      .catch((err) => log.error('[market-data] daily-emit pass failed:', err));

    // Sleep until the next poll. EOD cadence wakes per-market off each calendar's close
    // (+EOD_POLL_DELAY_MS) — a single shared anchor can't keep both markets fresh.
    // Intraday keeps the wall-clock-aligned grid (no drift across pod restarts).
    let sleepMs: number;
    if (isEod) {
      try {
        const cals = (['US', 'LSE'] as Market[])
          .filter((m) => groups[m].length > 0)
          .map((m) => calendarFor(m));
        sleepMs = cals.length > 0
          ? Math.max(60_000, (await soonestEodPollInstant(cals, EOD_POLL_DELAY_MS, Date.now())) - Date.now())
          : msUntilNextTick(pollIntervalMs, POLL_ANCHOR_OFFSET_MS);
      } catch (err) {
        log.warn('[market-data] EOD wake computation failed — falling back to grid:', err);
        sleepMs = msUntilNextTick(pollIntervalMs, POLL_ANCHOR_OFFSET_MS);
      }
    } else {
      sleepMs = msUntilNextTick(pollIntervalMs, POLL_ANCHOR_OFFSET_MS);
    }
    log.info(`[market-data] ── cycle ${cycleCounter} end in ${Date.now() - cycleStartMs}ms — next poll in ${(sleepMs / 1000).toFixed(0)}s at ${new Date(Date.now() + sleepMs).toISOString()}`);
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

const healthHandler = async (c: import('hono').Context) => {
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
};
app.get('/health', healthHandler);
app.get('/admin/api/market-data/health', healthHandler);

// Lightweight console-backed logger shim; market-data-service still runs from index.ts
// at module scope. Pino-backed logger is wired in src/main.ts and threaded down when the
// service is migrated to the modules/ shape.
const adminLogger = {
  info:  (...args: unknown[]) => log.info('[market-data:admin]', ...args),
  warn:  (...args: unknown[]) => log.warn('[market-data:admin]', ...args),
  error: (...args: unknown[]) => log.error('[market-data:admin]', ...args),
  debug: (...args: unknown[]) => log.debug('[market-data:admin]', ...args),
  trace: () => {},
  fatal: (...args: unknown[]) => log.error('[market-data:admin]', ...args),
  child: () => adminLogger, level: 'info',
} as unknown as Parameters<typeof createAdminRouter>[2];

app.route('/', createAdminRouter(universeManager, provider, adminLogger, {
  holidayCache: () => _holidayCache ?? (() => { throw new Error('holiday cache not bootstrapped'); })(),
  calendarFor,
}));
app.route('/', createInternalBarsRouter(universeManager));

// Fundamentals (QMJ) — read-through company_fundamentals cache + internal/admin routes.
// Provider selected by FUNDAMENTALS_PROVIDER (yahoo default; eodhd dormant until the add-on).
const fundamentalsCache = buildFundamentalsCache(
  async (amount, currency) => (await getFxClient()).toGBP({ amount, currency }),
  env.FUNDAMENTALS_PROVIDER,
  { requestSpacingMs: env.FUNDAMENTALS_REQUEST_SPACING_MS },
);
// Background QMJ refresher — keeps company_fundamentals populated off the request path (a full
// Yahoo walk runs for minutes; the admin endpoint just wakes this loop). Started in bootstrap()
// once the universe is resolved.
const fundamentalsRefresher = new FundamentalsRefreshScheduler(
  fundamentalsCache,
  () => universeManager.activeTickers,
  {
    idleMs:     env.FUNDAMENTALS_REFRESH_IDLE_MS,
    retryMs:    env.FUNDAMENTALS_REFRESH_RETRY_MS,
    progressMs: env.FUNDAMENTALS_REFRESH_PROGRESS_MS,
  },
);
app.route('/', createFundamentalsRouter(fundamentalsCache, universeManager, fundamentalsRefresher));
app.route('/', createScannerRouter(universeManager, fundamentalsCache));

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
    log.info('[market-data] holiday calendars hydrated');
  } catch (err) {
    log.warn('[market-data] holiday hydration failed (will retry on first poll):', err);
  }
  cache.startBackgroundRefresh();

  let universe: string[] = [];
  try {
    universe = await universeManager.refresh();
  } catch (err) {
    log.warn('[market-data] universe refresh failed during bootstrap, skipping backfill:', err);
  }
  if (universe.length === 0) {
    universe = (env.TICKER_UNIVERSE ?? '').split(',').filter(Boolean);
  }

  if (universe.length > 0) {
    try {
      const db = await getMongoDb();
      const missing = await tickersMissingHistory(db, universe);
      if (missing.length > 0) {
        log.info(`[market-data] bootstrap: ${missing.length}/${universe.length} tickers have no 5m history — backfilling`);
        const redis = await getRedisClient();
        const results = await backfillTickers(db, redis, provider, missing);
        const ok    = results.filter((r) => !r.error).length;
        const total = results.reduce((acc, r) => acc + r.upserted, 0);
        const fail  = results.filter((r) => r.error).length;
        log.info(`[market-data] bootstrap backfill complete: ${ok}/${results.length} tickers OK, ${total} bars upserted, ${fail} failures`);
      } else {
        log.info(`[market-data] bootstrap: all ${universe.length} tickers have history — skipping backfill`);
      }
    } catch (err) {
      log.warn('[market-data] bootstrap backfill failed:', err);
    }
  }

  // Long-range DAILY history bootstrap — runs in the background (multi-year × full-universe
  // Yahoo fetches take minutes; blocking pollLoop/health probes on it is worse than a brief
  // window of thin daily coverage). Idempotent: subsequent boots see coverage and skip.
  void (async () => {
    if (universe.length === 0) return;
    try {
      const db = await getMongoDb();
      const missingDaily = await tickersMissingDailyHistory(db, universe);
      if (missingDaily.length === 0) {
        log.info(`[market-data] bootstrap: all ${universe.length} tickers have sufficient daily history`);
        return;
      }
      log.info(`[market-data] bootstrap: ${missingDaily.length}/${universe.length} tickers missing long-range daily history — backfilling from ${env.DAILY_HISTORY_PROVIDER} (background)`);
      const redis = await getRedisClient();
      const results = await backfillDailyHistory(db, redis, missingDaily);
      const ok    = results.filter((r) => !r.error).length;
      const total = results.reduce((acc, r) => acc + r.upserted, 0);
      log.info(`[market-data] bootstrap daily backfill done: ${ok}/${results.length} tickers OK, ${total} daily rows`);
    } catch (err) {
      log.warn('[market-data] bootstrap daily backfill failed:', err);
    }
  })();

  // Universe is resolved by now — start the background QMJ refresher (first pass runs immediately,
  // populating any missing fundamentals, then self-paces). Independent of the bar poll cadence.
  fundamentalsRefresher.start();

  pollLoop().catch((err) => {
    log.error('[fatal]', err);
    process.exit(1);
  });

  // Quote poll — separate cadence + endpoint from bars (Yahoo v7/quote), shared rate budget.
  // Best-effort: a quote-poll crash must never take down the bar pipeline. latestBar feeds the
  // synthetic high-low fallback from the most recent stored 5m bar.
  try {
    const quotePoll = new QuotePoll({
      provider: buildQuoteProvider(),
      writer: new QuoteWriter(),
      activeTickers: () => universeManager.activeTickers,
      latestBar: async (ticker) => {
        const { rows } = await getPgPool().query<{ high: number; low: number; close: number }>(
          `SELECT high, low, close FROM bars
           WHERE ticker = $1 AND interval = '5m' AND is_superseded = FALSE
           ORDER BY observation_ts DESC LIMIT 1`,
          [ticker],
        );
        return rows.length ? { high: Number(rows[0]!.high), low: Number(rows[0]!.low), close: Number(rows[0]!.close) } : null;
      },
      logger: log as never,
    });
    quotePoll.start(env.QUOTE_POLL_INTERVAL_MS);
    log.info(`[market-data] quote poll started @ ${(env.QUOTE_POLL_INTERVAL_MS / 1000).toFixed(0)}s`);
  } catch (err) {
    log.warn('[market-data] quote poll failed to start (bars unaffected):', err);
  }
}

// Bootstrap runs unconditionally for prod runtime (node dist/main.js). Tests import
// helpers from this module via vitest's module loader, which uses a separate process.
bootstrap();

const port = env.PORT;
mountMetrics(app);   // GET /metrics (Prometheus) — market-data uses its own serve, not core's listen()
serve({ fetch: app.fetch, port }, (info) => {
  log.info(`[market-data-service] listening on :${info.port}`);
});
