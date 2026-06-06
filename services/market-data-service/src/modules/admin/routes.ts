// Admin routes for portal-driven runtime overrides. Gated by internal-token check;
// the api-gateway is the only authorized caller and enforces user-level admin auth.

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Logger } from '@trader/core';
import { MarketData as MarketDataContracts } from '@trader/contracts';
import { parseAdminHeaders, parseInternalHeaders } from '@trader/shared-auth/middleware';
import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import { getRedisClient, xAdd } from '@trader/shared-redis';
import { getLiveConfig, invalidateLiveConfig, _envDefaultsForTest } from '../../shared/live-config.ts';
import { getRuntimeEnv } from '../../runtime-env.ts';
import type { UniverseManager } from '../universe/application/UniverseManager.ts';
import { MongoInstrumentMeta } from '../universe/infrastructure/MongoInstrumentMeta.ts';
import type { MarketDataProvider } from '../bars/infrastructure/providers/market-data-provider.ts';
import { aggregateBars, getBars, invalidateBars, type RangeKey } from '@trader/shared-bars';
import { backfillTickers, CACHE_INVALIDATED_TOPIC } from '../bars/infrastructure/backfill.ts';
import { backfillDailyHistory } from '../bars/infrastructure/daily-history.ts';
import { REDIS_STREAMS, POLL_INTERVAL_OPTIONS, type BarInterval, type OHLCVBar, type PollIntervalKey } from '@trader/shared-types';
import type { HolidayCache, ExchangeCalendar, Market } from '@trader/shared-calendar';
import { scheduleBetween, marketStateOf } from '@trader/shared-calendar';

interface UniverseOverridesDoc {
  _id: 'singleton';
  adds: string[];
  removes: string[];
  updatedBy: string;
  updatedAt: Date;
}

// Numeric enum constants for OrderType — mirrored from
// services/trading-service/src/domain/entities/Order.ts. Defined inline rather than
// imported across services to keep admin-routes peer-service-agnostic. Values MUST
// match (Limit=0, Market=1) or the live-config layer will read the wrong field.
const ORDER_TYPE_LIMIT  = 0;
const ORDER_TYPE_MARKET = 1;
const ORDER_TYPE_VALUES = [ORDER_TYPE_LIMIT, ORDER_TYPE_MARKET];

interface MarketConfigDoc {
  _id: 'singleton';
  barFrequency: 'daily' | 'intraday' | null;
  pollIntervalMs: number | null;
  // OrderType override consumed live by trading-service (and by strategy-engine, which
  // exits cleanly so k8s restarts it when the bar regime flips). Stored as the numeric
  // enum value (0=Limit, 1=Market) alongside the bar/poll knobs so a single doc + single
  // PUT propagates everything from one save.
  signalOrderType: 0 | 1 | null;
  // Max active-universe size override, consumed by UniverseManager.refresh() (live via the
  // maxSizeResolver). null = use the Helm/env UNIVERSE_MAX_SIZE.
  universeMaxSize: number | null;
  updatedBy: string;
  updatedAt: Date;
}

// Pubsub topic that trading-service + strategy-engine subscribe to so they drop their
// 15s live-config caches the instant the doc changes — without it, the operator would
// see up to 15s of stale behaviour after a portal save before the cache TTL expired.
export const CONFIG_INVALIDATED_TOPIC = 'config:invalidated';

const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 24 * 60 * 60_000;
// Universe-size override bounds. Floor keeps the sector cap + US/LSE balance meaningful; ceiling
// guards the optimiser's conditioning band (see the design doc Top-K / mathematical-foundations §6.1).
const MIN_UNIVERSE_SIZE = 10;
const MAX_UNIVERSE_SIZE = 500;

// '4h' aggregates from the 5m series (best-effort — depends on 5m freshness); 'weekly'
// from the persisted daily series. Both are derived-on-read in aggregateBars.
const VALID_INTERVALS: BarInterval[] = ['5m', '15m', '1h', '4h', 'daily', 'weekly'];
const VALID_RANGES: RangeKey[]     = ['30d', '60d', '90d', '180d', '1y', '2y', '5y', 'max'];

// Read a downsampled OHLCV series for one ticker. Long-horizon views (`daily`, `weekly`)
// read the persisted `interval:'daily'` series directly — aggregating 5m would cap at the
// 60d 5m retention, which is far too short for a weekly chart. `weekly` is then ISO-week
// aggregated off that daily series. Intraday views (`5m`/`15m`/`1h`/`4h`) aggregate the
// stored 5m series (so `4h` is best-effort — only as fresh as the 5m series).
async function readBarsSeries(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  db: Awaited<ReturnType<typeof getMongoDb>>,
  ticker: string,
  interval: BarInterval,
  range: RangeKey,
  asOf: number | undefined,
): Promise<OHLCVBar[]> {
  const opts = asOf !== undefined ? { asOf } : {};
  if (interval === 'daily' || interval === 'weekly') {
    let source = await getBars(redis as any, db, ticker, 'daily', range, opts);
    if (source.length === 0) {
      // Daily series not yet seeded for this ticker (pre-backfill window) — fall back to
      // aggregating the recent 5m series so callers still get a short-range view.
      const base5 = await getBars(redis as any, db, ticker, '5m', range, opts);
      source = aggregateBars(base5, 'daily');
    }
    return interval === 'weekly' ? aggregateBars(source, 'weekly') : source;
  }
  const base = await getBars(redis as any, db, ticker, '5m', range, opts);
  return aggregateBars(base, interval);
}

export interface CalendarDeps {
  holidayCache: () => HolidayCache;
  calendarFor:  (m: Market) => ExchangeCalendar;
}

export function createAdminRouter(
  universeManager: UniverseManager,
  provider: MarketDataProvider,
  logger: Logger,
  calendarDeps?: CalendarDeps,
): Hono {
  const r = new Hono();
  // Path-scoped, NOT `r.use('*', mw)`. A wildcard `use('*', mw)` on a subapp mounted
  // via `app.route('/', subapp)` bleeds the middleware onto every route registered
  // afterward on the PARENT app — including createInternalBarsRouter's /internal/api/*
  // routes, which then fail their own parser. Same regression that bit trading-service
  // routing; see services/trading-service/__tests__/routing.test.ts for the fixture.
  r.use('/admin/api/market-data/*', parseAdminHeaders);

  // ── Universe overrides ────────────────────────────────────────────────────
  r.get('/admin/api/market-data/universe/overrides', async (c) => {
    const db = await getMongoDb();
    const doc = await db.collection<UniverseOverridesDoc>(COLLECTIONS.PORTAL_UNIVERSE_OVERRIDES)
      .findOne({ _id: 'singleton' });

    // Enrich the active universe from instrument_registry so the portal can render
    // market + ADV per ticker. Fall back to bare tickers if the registry is empty
    // (cold start before first refresh). The activeUniverse string array is kept for
    // backwards-compat with anything that still treats it as `string[]`.
    type RegistryDoc = { ticker: string; name?: string; sector?: string; market?: string; adv?: number };
    const activeTickers = universeManager.activeTickers;
    const registry = await db.collection<RegistryDoc>(COLLECTIONS.INSTRUMENT_REGISTRY)
      .find({ ticker: { $in: activeTickers }, activeTo: null })
      .project({ _id: 0, ticker: 1, name: 1, sector: 1, market: 1, adv: 1 })
      .toArray();
    const byTicker = new Map<string, RegistryDoc>(registry.map((r) => [r.ticker, r as RegistryDoc] as const));
    const activeUniverseDetailed = activeTickers.map((t) => {
      const reg = byTicker.get(t);
      const inferredMarket: 'US' | 'LSE' | 'OTHER' =
        reg?.market as 'US' | 'LSE' | 'OTHER' | undefined
        ?? (/_US_EQ$/.test(t) ? 'US' : /l_EQ$/.test(t) ? 'LSE' : 'OTHER');
      return {
        ticker: t,
        name:   reg?.name ?? t,
        sector: reg?.sector ?? 'Unknown',
        market: inferredMarket,
        adv:    reg?.adv ?? 0,
      };
    });

    return c.json({
      adds: doc?.adds ?? [],
      removes: doc?.removes ?? [],
      activeUniverse: activeTickers,
      activeUniverseDetailed,
      sectorMap: universeManager.sectorMap,
      updatedBy: doc?.updatedBy ?? null,
      updatedAt: doc?.updatedAt ?? null,
    });
  });

  r.put(
    '/admin/api/market-data/universe/overrides',
    zValidator('json', MarketDataContracts.UniverseOverridesRequestSchema),
    async (c) => {
      const body = c.req.valid('json');
      // Preserve case so T212 suffixes (e.g. `l_EQ` for London) survive. Earlier code upper-cased
      // every entry, which silently broke any non-_US_EQ ticker passing through portal overrides.
      const norm = (arr: string[] | undefined): string[] =>
        (arr ?? []).map((t) => t.trim()).filter(Boolean);
      const adds = norm(body.adds);
      const removes = norm(body.removes);
      const db = await getMongoDb();
      await db.collection(COLLECTIONS.PORTAL_UNIVERSE_OVERRIDES).updateOne(
        { _id: 'singleton' as any },
        { $set: { adds, removes, updatedBy: body.userId ?? 'unknown', updatedAt: new Date() } },
        { upsert: true },
      );
      return c.json({ ok: true, adds, removes });
    },
  );

  r.post('/admin/api/market-data/universe/refresh', async (c) => {
    const tickers = await universeManager.refresh();
    return c.json({ ok: true, universeSize: tickers.length, activeUniverse: tickers });
  });

  // ── Market-data config overrides ──────────────────────────────────────────
  r.get('/admin/api/market-data/config', async (c) => {
    const db = await getMongoDb();
    const doc = await db.collection<MarketConfigDoc>(COLLECTIONS.PORTAL_MARKET_CONFIG)
      .findOne({ _id: 'singleton' });
    const effective = await getLiveConfig();
    // signalOrderType isn't consumed by market-data-service itself; we surface the env
    // fallback so the portal's "Helm defaults" panel renders symmetrically with the
    // bar/poll columns. Override is whatever the doc says (null = no override). Env is
    // parsed both ways — accept the enum-member name ('Limit' / 'Market') for human
    // readability in Helm AND the integer value for parameterised setups.
    const rawSignalOrderType = getRuntimeEnv().SIGNAL_ORDER_TYPE;
    const envSignalOrderType: 0 | 1 =
      rawSignalOrderType === 'Market' || rawSignalOrderType === String(ORDER_TYPE_MARKET)
        ? ORDER_TYPE_MARKET
        : ORDER_TYPE_LIMIT;
    return c.json({
      override: {
        barFrequency: doc?.barFrequency ?? null,
        pollIntervalMs: doc?.pollIntervalMs ?? null,
        signalOrderType: doc?.signalOrderType ?? null,
        universeMaxSize: doc?.universeMaxSize ?? null,
      },
      effective: {
        ...effective,
        signalOrderType: doc?.signalOrderType ?? envSignalOrderType,
      },
      defaults: {
        ..._envDefaultsForTest(),
        signalOrderType: envSignalOrderType,
      },
      updatedBy: doc?.updatedBy ?? null,
      updatedAt: doc?.updatedAt ?? null,
    });
  });

  r.put(
    '/admin/api/market-data/config',
    zValidator('json', MarketDataContracts.MarketConfigRequestSchema),
    async (c) => {
      const body = c.req.valid('json');
      if (body.universeMaxSize != null &&
          (body.universeMaxSize < MIN_UNIVERSE_SIZE || body.universeMaxSize > MAX_UNIVERSE_SIZE)) {
        return c.json({ error: `universeMaxSize out of range (${MIN_UNIVERSE_SIZE}..${MAX_UNIVERSE_SIZE})` }, 400);
      }
      if (body.pollIntervalMs != null) {
        if (body.pollIntervalMs < MIN_POLL_MS || body.pollIntervalMs > MAX_POLL_MS) {
          return c.json({ error: `pollIntervalMs out of range (${MIN_POLL_MS}..${MAX_POLL_MS})` }, 400);
        }
        // Defence-in-depth: zod accepts any positive int; reject anything outside the active
        // provider's allowedPollIntervals.
        const allowedMs = provider.allowedPollIntervals.map((k) => POLL_INTERVAL_OPTIONS[k].ms);
        if (!allowedMs.includes(body.pollIntervalMs)) {
          return c.json({
            error: `pollIntervalMs not allowed by provider ${provider.name}`,
            allowed: allowedMs,
          }, 400);
        }
      }
      const db = await getMongoDb();
      await db.collection(COLLECTIONS.PORTAL_MARKET_CONFIG).updateOne(
        { _id: 'singleton' as any },
        { $set: {
          barFrequency: body.barFrequency ?? null,
          pollIntervalMs: body.pollIntervalMs ?? null,
          signalOrderType: body.signalOrderType ?? null,
          universeMaxSize: body.universeMaxSize ?? null,
          updatedBy: body.userId ?? 'unknown',
          updatedAt: new Date(),
        }},
        { upsert: true },
      );
      invalidateLiveConfig();
      // Best-effort: tell trading-service + strategy-engine to drop their caches now.
      try {
        const redis = await getRedisClient();
        await redis.publish(CONFIG_INVALIDATED_TOPIC, JSON.stringify({
          barFrequency:    body.barFrequency    ?? null,
          signalOrderType: body.signalOrderType ?? null,
          pollIntervalMs:  body.pollIntervalMs  ?? null,
          ts: Date.now(),
        }));
      } catch (err) {
        logger.warn({ err }, 'config-invalidated publish failed');
      }
      return c.json({ ok: true });
    },
  );

  // ── Backfill 5m history ────────────────────────────────────────────────────
  // POST /api/admin/market-data/backfill
  // body: { tickers?: string[], days?: number }
  //   tickers omitted → use active universe.
  //   days defaults to 60 (matches Yahoo 5m lookback cap).
  // Persists 5m bars (upsert), invalidates the shared-bars cache, and publishes a
  // cache-invalidated message per ticker so subscribers (signal-service, portal) drop
  // their derived state. Returns per-ticker upsert counts.
  r.post(
    '/admin/api/market-data/backfill',
    zValidator('json', MarketDataContracts.BackfillRequestSchema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid body', issues: result.error.issues }, 400);
    }),
    async (c) => {
      const body = c.req.valid('json');
      const tickers = body.tickers && body.tickers.length > 0
        ? body.tickers
        : universeManager.activeTickers;
      if (tickers.length === 0) return c.json({ error: 'no tickers (universe empty and no body.tickers)' }, 400);
      const days = body.days ?? 60;
      const db = await getMongoDb();
      const redis = await getRedisClient();
      const results = await backfillTickers(db, redis, provider, tickers, {
        windowMs: days * 24 * 60 * 60_000,
      });
      return c.json({
        tickers: results.length,
        bars:    results.reduce((acc, r) => acc + r.upserted, 0),
        failures: results.filter((r) => r.error).length,
        results,
      });
    },
  );

  // ── Backfill long-range DAILY history (Yahoo, multi-year) ──────────────────
  // POST /api/admin/market-data/backfill-daily
  // body: { tickers?: string[], years?: number }  (tickers omitted → active universe)
  // Seeds the persisted interval:'daily' series that strategy lookbacks read (12-1 momentum
  // etc.). Yahoo-sourced + free, decoupled from the metered 5m provider.
  r.post(
    '/admin/api/market-data/backfill-daily',
    zValidator('json', MarketDataContracts.BackfillDailyRequestSchema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid body', issues: result.error.issues }, 400);
    }),
    async (c) => {
      const body = c.req.valid('json');
      const tickers = body.tickers && body.tickers.length > 0
        ? body.tickers
        : universeManager.activeTickers;
      if (tickers.length === 0) return c.json({ error: 'no tickers (universe empty and no body.tickers)' }, 400);
      const db = await getMongoDb();
      const redis = await getRedisClient();
      const results = await backfillDailyHistory(db, redis, tickers, body.years !== undefined ? { years: body.years } : {});
      return c.json({
        tickers: results.length,
        bars:    results.reduce((acc, r) => acc + r.upserted, 0),
        failures: results.filter((r) => r.error).length,
        results,
      });
    },
  );

  // ── Clear cached bars ──────────────────────────────────────────────────────
  // POST /api/admin/market-data/clear-cache
  // body: { interval?: BarInterval, beforeTimestamp?: number (ms), dryRun?: boolean }
  //   No args (with dryRun=false) → wipes the entire ohlcv_bars collection.
  //   Operator-driven; default dryRun=true returns counts without deleting.
  // Use this to clean up the existing duplicate intraday-snapshot rows that the buggy
  // insertMany loop persisted before the upsert switch. Also drops shared-bars Redis
  // cache entries for matching (ticker, interval) pairs.
  r.post(
    '/admin/api/market-data/clear-cache',
    zValidator('json', MarketDataContracts.ClearCacheRequestSchema),
    async (c) => {
      const body = c.req.valid('json');
      const dryRun = body.dryRun !== false;

      const filter: Record<string, unknown> = {};
      if (body.interval)        filter.interval  = body.interval;
      if (body.beforeTimestamp) filter.timestamp = { $lt: new Date(body.beforeTimestamp) };

      const db = await getMongoDb();
      const collection = db.collection(COLLECTIONS.OHLCV_BARS);
      const matchCount = await collection.countDocuments(filter);
      if (dryRun) {
        return c.json({ dryRun: true, wouldDelete: matchCount, filter });
      }

      const res = await collection.deleteMany(filter);
      const redis = await getRedisClient();
      try {
        await redis.publish(CACHE_INVALIDATED_TOPIC, JSON.stringify({ scope: 'bulk', filter, deleted: res.deletedCount, ts: Date.now() }));
      } catch (err) {
        logger.warn({ err }, 'clear-cache publish failed');
      }
      return c.json({ deleted: res.deletedCount, filter });
    },
  );

  // ── Provider info ──────────────────────────────────────────────────────────
  // GET /api/admin/market-data/provider-info
  // Returns the active provider's identity + lookback cap + the poll-interval keys
  // it's willing to serve. The portal calls this once on mount to populate the
  // poll-cadence dropdown and to show which provider is active.
  r.get('/admin/api/market-data/provider-info', (c) => {
    return c.json({
      name:          provider.name,
      maxLookbackMs: provider.maxLookbackMs,
      // Hydrate each allowed key with its full PollIntervalOption so the portal
      // doesn't have to import shared-types — keeps the FE single-package-deep on
      // its own types/trader.ts copy.
      allowedPollIntervals: provider.allowedPollIntervals
        .map((k) => POLL_INTERVAL_OPTIONS[k])
        .filter(Boolean),
    });
  });

  // ── Which tickers actually have cached 5m history ──────────────────────────
  // GET /api/admin/market-data/coverage
  // Returns { ticker: { count, revisions } } for every ticker with at least one 5m bar.
  // `count` is unsuperseded rows (observation count); `revisions` is the total
  // bar_revisions_log entries for that ticker — operator dashboards use the ratio to
  // flag tickers Yahoo has been actively revising.
  r.get('/admin/api/market-data/coverage', async (c) => {
    const db = await getMongoDb();
    const [obsAgg, revAgg] = await Promise.all([
      db.collection(COLLECTIONS.OHLCV_BARS).aggregate([
        { $match: { interval: '5m', is_superseded: false } },
        { $group: { _id: '$ticker', count: { $sum: 1 } } },
      ]).toArray(),
      db.collection(COLLECTIONS.BAR_REVISIONS_LOG).aggregate([
        { $match: { interval: '5m', prior_hash: { $ne: null } } },  // skip first-prints
        { $group: { _id: '$ticker', revisions: { $sum: 1 } } },
      ]).toArray(),
    ]);
    const coverage: Record<string, { count: number; revisions: number }> = {};
    for (const row of obsAgg) coverage[row._id as string] = {
      count:     (row as Record<string, number>).count ?? 0,
      revisions: 0,
    };
    for (const row of revAgg) {
      const k = row._id as string;
      if (coverage[k]) coverage[k].revisions = (row as Record<string, number>).revisions ?? 0;
      else coverage[k] = { count: 0, revisions: (row as Record<string, number>).revisions ?? 0 };
    }
    return c.json({ coverage });
  });

  // ── Read bars (downsampled view) ───────────────────────────────────────────
  // GET /api/admin/market-data/bars/:ticker?interval=daily&range=60d[&asOf=<ms>]
  // Returns the 5m series for the ticker, downsampled to the requested interval and
  // trimmed to the requested range. When asOf is omitted, returns the latest
  // unsuperseded revision per observation (live view). When set, returns the latest
  // revision known at that knowledge time (bi-temporal as-of view) — used by audits
  // and historical backtest replays.
  r.get('/admin/api/market-data/bars/:ticker', async (c) => {
    const ticker   = c.req.param('ticker');
    const interval = (c.req.query('interval') ?? 'daily') as BarInterval;
    const range    = (c.req.query('range')    ?? '30d')   as RangeKey;
    const asOfRaw  = c.req.query('asOf');
    if (!VALID_INTERVALS.includes(interval)) {
      return c.json({ error: `invalid interval (one of ${VALID_INTERVALS.join(',')})` }, 400);
    }
    if (!VALID_RANGES.includes(range)) {
      return c.json({ error: `invalid range (one of ${VALID_RANGES.join(',')})` }, 400);
    }
    let asOf: number | undefined;
    if (asOfRaw != null && asOfRaw !== '') {
      const parsed = Number(asOfRaw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return c.json({ error: 'asOf must be a positive integer (UTC ms)' }, 400);
      }
      asOf = parsed;
    }
    const db    = await getMongoDb();
    const redis = await getRedisClient();
    // `daily` reads the persisted daily series directly (long-range); intraday intervals
    // downsample the stored 5m series. See readBarsSeries.
    const out = await readBarsSeries(redis, db, ticker, interval, range, asOf);
    return c.json({ ticker, interval, range, asOf: asOf ?? null, bars: out });
  });

  // ── Revision log (operator inspection of bi-temporal write history) ────────
  // GET /api/admin/market-data/revisions/:ticker?since=<ms>&limit=<n>
  // Returns the per-(ticker, observation_ts) revision audit trail since the given
  // knowledge_ts. Drives the portal's revisions panel — operator looks here when a
  // bar value seems suspicious or when a `revision_zscore_anomaly` lands.
  r.get('/admin/api/market-data/revisions/:ticker', async (c) => {
    const ticker = c.req.param('ticker');
    const sinceRaw = c.req.query('since');
    const limitRaw = c.req.query('limit');
    const since = sinceRaw != null ? Number(sinceRaw) : 0;
    const limit = Math.min(500, Math.max(1, limitRaw != null ? Number(limitRaw) : 100));
    if (!Number.isFinite(since) || since < 0) {
      return c.json({ error: 'since must be a non-negative integer (UTC ms)' }, 400);
    }
    const db = await getMongoDb();
    const rows = await db.collection(COLLECTIONS.BAR_REVISIONS_LOG)
      .find({ ticker, knowledge_ts: { $gte: since } })
      .sort({ knowledge_ts: -1 })
      .limit(limit)
      .toArray();
    return c.json({ ticker, since, count: rows.length, revisions: rows });
  });

  // ── Session calendar endpoints ───────────────────────────────────────────
  // Powers the portal /market-data/calendar page and the source-health panel.
  // calendarDeps is optional only because legacy tests construct the router without
  // calendars; production wiring always passes them. Endpoints 503 when absent.

  r.get('/admin/api/market-data/calendar', async (c) => {
    if (!calendarDeps) return c.json({ error: 'calendar not configured' }, 503);
    const days = Math.min(60, Math.max(1, parseInt(c.req.query('days') ?? '30', 10)));
    const now = Date.now();
    const toMs = now + days * 86_400_000;
    const [us, lse] = await Promise.all([
      scheduleBetween(calendarDeps.calendarFor('US'),  now, toMs),
      scheduleBetween(calendarDeps.calendarFor('LSE'), now, toMs),
    ]);
    const [usState, lseState] = await Promise.all([
      marketStateOf(calendarDeps.calendarFor('US'),  now),
      marketStateOf(calendarDeps.calendarFor('LSE'), now),
    ]);
    return c.json({
      generatedAt: now,
      days,
      current: { US: usState, LSE: lseState },
      schedule: { US: us, LSE: lse },
    });
  });

  r.get('/admin/api/market-data/holiday-sources', async (c) => {
    if (!calendarDeps) return c.json({ error: 'calendar not configured' }, 503);
    const health = await calendarDeps.holidayCache().getSourceHealth();
    return c.json({ generatedAt: Date.now(), sources: health });
  });

  r.post('/admin/api/market-data/holiday-refresh', async (c) => {
    if (!calendarDeps) return c.json({ error: 'calendar not configured' }, 503);
    await calendarDeps.holidayCache().refreshAll();
    const health = await calendarDeps.holidayCache().getSourceHealth();
    logger.info('holiday tables refreshed via admin endpoint');
    return c.json({ ok: true, sources: health });
  });

  return r;
}

// ─── Internal bars endpoint, separate from the admin router ─────────────────────
//
// Mounted at the same app level but with its own internal-token caller — strategy-engine
// calls this every cycle to hydrate its rolling window from Mongo (read-through cached
// in shared-bars). Kept separate from createAdminRouter so the wildcard 'api-gateway'
// middleware on that router doesn't bleed onto these routes.
//
// Batch endpoint (POST with tickers[]) is the hot path during boot: strategy-engine
// fetches the full universe's history in one HTTP round-trip per cycle rather than
// N round-trips. Single-ticker GET stays for ad-hoc tooling.
export function createInternalBarsRouter(universeManager: UniverseManager): Hono {
  const r = new Hono();


  r.get('/internal/api/market-data/bars/:ticker', parseInternalHeaders('strategy-engine'), async (c) => {
    const ticker   = c.req.param('ticker')!;
    const interval = (c.req.query('interval') ?? 'daily') as BarInterval;
    const range    = (c.req.query('range')    ?? '30d')   as RangeKey;
    const asOfRaw  = c.req.query('asOf');
    if (!VALID_INTERVALS.includes(interval)) {
      return c.json({ error: `invalid interval (one of ${VALID_INTERVALS.join(',')})` }, 400);
    }
    if (!VALID_RANGES.includes(range)) {
      return c.json({ error: `invalid range (one of ${VALID_RANGES.join(',')})` }, 400);
    }
    let asOf: number | undefined;
    if (asOfRaw != null && asOfRaw !== '') {
      const parsed = Number(asOfRaw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return c.json({ error: 'asOf must be a positive integer (UTC ms)' }, 400);
      }
      asOf = parsed;
    }
    const db    = await getMongoDb();
    const redis = await getRedisClient();
    const out = await readBarsSeries(redis, db, ticker, interval, range, asOf);
    return c.json({ ticker, interval, range, asOf: asOf ?? null, bars: out });
  });

  r.post(
    '/internal/api/market-data/bars',
    parseInternalHeaders('strategy-engine'),
    zValidator('json', MarketDataContracts.InternalBarsRequestSchema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid body', issues: result.error.issues }, 400);
    }),
    async (c) => {
      const body = c.req.valid('json');
      const interval = body.interval ?? 'daily';
      const range    = body.range    ?? '30d';
      const asOf     = body.asOf;

      const db    = await getMongoDb();
      const redis = await getRedisClient();
      const out: Record<string, OHLCVBar[]> = {};
      // Per-ticker fetch is cheap because getBars hits Redis on the second-onwards
      // call within a TTL window. We could parallelise with Promise.all if the cache
      // miss path proves slow in production; for now serial is simpler and predictable.
      for (const ticker of body.tickers) {
        out[ticker] = await readBarsSeries(redis, db, ticker, interval, range, asOf);
      }
      return c.json({ interval, range, asOf: asOf ?? null, bars: out });
    },
  );

  // Universe → sector lookup. strategy-engine hits this once per cycle to hydrate
  // its `_strategy._sectors` dict from the read-through Mongo cache that UniverseManager
  // refreshes from Yahoo (`assetProfile.sector`). Always returns one entry per active
  // universe ticker — `'Unknown'` is the documented fallback when neither cache nor
  // Yahoo has resolved a sector. fetchedAt is the timestamp of the freshest row in the
  // returned set (caller can compute staleness without a second round-trip).
  r.get(
    '/internal/api/universe/sectors',
    parseInternalHeaders('strategy-engine', 'notification-service'),
    async (c) => {
      const tickers = universeManager.activeTickers;
      const db = await getMongoDb();
      const metaRepo = new MongoInstrumentMeta(db);
      const rows = await metaRepo.findMany(tickers);

      const sectors: Record<string, string> = {};
      let freshest = 0;
      for (const t of tickers) {
        const row = rows[t];
        sectors[t] = row?.sector ?? 'Unknown';
        if (row?.fetchedAt) freshest = Math.max(freshest, row.fetchedAt.getTime());
      }
      return c.json({ sectors, fetchedAt: freshest });
    },
  );

  return r;
}
