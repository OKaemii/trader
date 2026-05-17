// Admin routes for portal-driven runtime overrides. Gated by internal-token check;
// the api-gateway is the only authorized caller and enforces user-level admin auth.

import { Hono } from 'hono';
import { requireInternalToken } from '@trader/shared-auth/middleware';
import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import { getRedisClient, xAdd } from '@trader/shared-redis';
import { getLiveConfig, invalidateLiveConfig, _envDefaultsForTest } from './live-config.ts';
import type { UniverseManager } from './universe-manager.ts';
import type { MarketDataProvider } from './providers/market-data-provider.ts';
import { aggregateBars, getBars, invalidateBars, type RangeKey } from '@trader/shared-bars';
import { backfillTickers, CACHE_INVALIDATED_TOPIC } from './backfill.ts';
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
  updatedBy: string;
  updatedAt: Date;
}

// Pubsub topic that trading-service + strategy-engine subscribe to so they drop their
// 15s live-config caches the instant the doc changes — without it, the operator would
// see up to 15s of stale behaviour after a portal save before the cache TTL expired.
export const CONFIG_INVALIDATED_TOPIC = 'config:invalidated';

const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 24 * 60 * 60_000;

const VALID_INTERVALS: BarInterval[] = ['5m', '15m', '1h', 'daily'];
const VALID_RANGES: RangeKey[]     = ['30d', '60d', '90d'];

export interface CalendarDeps {
  holidayCache: () => HolidayCache;
  calendarFor:  (m: Market) => ExchangeCalendar;
}

export function createAdminRouter(
  universeManager: UniverseManager,
  provider: MarketDataProvider,
  calendarDeps?: CalendarDeps,
): Hono {
  const r = new Hono();
  // Path-scoped, NOT `r.use('*', mw)`. A wildcard `use('*', mw)` on a subapp mounted
  // via `app.route('/', subapp)` bleeds the middleware onto every route registered
  // afterward on the PARENT app — including createInternalBarsRouter's /internal/bars
  // routes, which then 403 because they expect caller='strategy-engine' not 'api-gateway'.
  // Same regression that bit trading-service routing; see services/trading-service
  // routing.test.ts for the fixture that pins it.
  r.use('/api/admin/*', requireInternalToken('api-gateway'));

  // ── Universe overrides ────────────────────────────────────────────────────
  r.get('/api/admin/universe/overrides', async (c) => {
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
    const byTicker = new Map<string, RegistryDoc>(registry.map((r) => [r.ticker, r]));
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

  r.put('/api/admin/universe/overrides', async (c) => {
    const body = await c.req.json<{ adds?: string[]; removes?: string[]; userId?: string }>();
    // Preserve case so T212 suffixes (e.g. `l_EQ` for London) survive. Earlier code upper-cased
    // every entry, which silently broke any non-_US_EQ ticker passing through portal overrides.
    const norm = (arr: string[] | undefined) =>
      (arr ?? []).map((t) => t.trim()).filter(Boolean);
    const adds = norm(body.adds);
    const removes = norm(body.removes);
    const db = await getMongoDb();
    await db.collection(COLLECTIONS.PORTAL_UNIVERSE_OVERRIDES).updateOne(
      { _id: 'singleton' },
      { $set: { adds, removes, updatedBy: body.userId ?? 'unknown', updatedAt: new Date() } },
      { upsert: true },
    );
    return c.json({ ok: true, adds, removes });
  });

  r.post('/api/admin/universe/refresh', async (c) => {
    const tickers = await universeManager.refresh();
    return c.json({ ok: true, universeSize: tickers.length, activeUniverse: tickers });
  });

  // ── Market-data config overrides ──────────────────────────────────────────
  r.get('/api/admin/market-data/config', async (c) => {
    const db = await getMongoDb();
    const doc = await db.collection<MarketConfigDoc>(COLLECTIONS.PORTAL_MARKET_CONFIG)
      .findOne({ _id: 'singleton' });
    const effective = await getLiveConfig();
    // signalOrderType isn't consumed by market-data-service itself; we surface the env
    // fallback so the portal's "Helm defaults" panel renders symmetrically with the
    // bar/poll columns. Override is whatever the doc says (null = no override). Env is
    // parsed both ways — accept the enum-member name ('Limit' / 'Market') for human
    // readability in Helm AND the integer value for parameterised setups.
    const envSignalOrderType: 0 | 1 =
      process.env.SIGNAL_ORDER_TYPE === 'Market' || process.env.SIGNAL_ORDER_TYPE === String(ORDER_TYPE_MARKET)
        ? ORDER_TYPE_MARKET
        : ORDER_TYPE_LIMIT;
    return c.json({
      override: {
        barFrequency: doc?.barFrequency ?? null,
        pollIntervalMs: doc?.pollIntervalMs ?? null,
        signalOrderType: doc?.signalOrderType ?? null,
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

  r.put('/api/admin/market-data/config', async (c) => {
    const body = await c.req.json<{
      barFrequency?: 'daily' | 'intraday' | null;
      pollIntervalMs?: number | null;
      signalOrderType?: 0 | 1 | null;
      userId?: string;
    }>();
    if (body.barFrequency != null && !['daily', 'intraday'].includes(body.barFrequency)) {
      return c.json({ error: 'invalid barFrequency' }, 400);
    }
    if (body.signalOrderType != null && !ORDER_TYPE_VALUES.includes(body.signalOrderType)) {
      return c.json({ error: `invalid signalOrderType (expected ${ORDER_TYPE_LIMIT}=Limit or ${ORDER_TYPE_MARKET}=Market)` }, 400);
    }
    if (body.pollIntervalMs != null) {
      if (body.pollIntervalMs < MIN_POLL_MS || body.pollIntervalMs > MAX_POLL_MS) {
        return c.json({ error: `pollIntervalMs out of range (${MIN_POLL_MS}..${MAX_POLL_MS})` }, 400);
      }
      // Defence-in-depth: even if the portal renders the dropdown correctly, a stale
      // tab or direct API hit could submit any value. Reject anything not in the
      // active provider's allowedPollIntervals.
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
      { _id: 'singleton' },
      { $set: {
        barFrequency: body.barFrequency ?? null,
        pollIntervalMs: body.pollIntervalMs ?? null,
        signalOrderType: body.signalOrderType ?? null,
        updatedBy: body.userId ?? 'unknown',
        updatedAt: new Date(),
      }},
      { upsert: true },
    );
    invalidateLiveConfig();
    // Best-effort: tell trading-service + strategy-engine to drop their caches now
    // rather than wait up to 15s for TTL. Failing to publish doesn't block the save —
    // subscribers will pick up the change on their next cache refresh either way.
    try {
      const redis = await getRedisClient();
      await redis.publish(CONFIG_INVALIDATED_TOPIC, JSON.stringify({
        barFrequency:   body.barFrequency   ?? null,
        signalOrderType:  body.signalOrderType  ?? null,
        pollIntervalMs: body.pollIntervalMs ?? null,
        ts: Date.now(),
      }));
    } catch (err) {
      console.warn('[admin] config-invalidated publish failed:', err);
    }
    return c.json({ ok: true });
  });

  // ── Backfill 5m history ────────────────────────────────────────────────────
  // POST /api/admin/market-data/backfill
  // body: { tickers?: string[], days?: number }
  //   tickers omitted → use active universe.
  //   days defaults to 60 (matches Yahoo 5m lookback cap).
  // Persists 5m bars (upsert), invalidates the shared-bars cache, and publishes a
  // cache-invalidated message per ticker so subscribers (signal-service, portal) drop
  // their derived state. Returns per-ticker upsert counts.
  r.post('/api/admin/market-data/backfill', async (c) => {
    const body = await c.req.json<{ tickers?: string[]; days?: number }>().catch(() => ({}));
    const tickers = body.tickers && body.tickers.length > 0
      ? body.tickers
      : universeManager.activeTickers;
    if (tickers.length === 0) return c.json({ error: 'no tickers (universe empty and no body.tickers)' }, 400);
    const days = body.days && body.days > 0 && body.days <= 60 ? body.days : 60;
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
  });

  // ── Clear cached bars ──────────────────────────────────────────────────────
  // POST /api/admin/market-data/clear-cache
  // body: { interval?: BarInterval, beforeTimestamp?: number (ms), dryRun?: boolean }
  //   No args (with dryRun=false) → wipes the entire ohlcv_bars collection.
  //   Operator-driven; default dryRun=true returns counts without deleting.
  // Use this to clean up the existing duplicate intraday-snapshot rows that the buggy
  // insertMany loop persisted before the upsert switch. Also drops shared-bars Redis
  // cache entries for matching (ticker, interval) pairs.
  r.post('/api/admin/market-data/clear-cache', async (c) => {
    const body = await c.req.json<{
      interval?: BarInterval;
      beforeTimestamp?: number;
      dryRun?: boolean;
    }>().catch(() => ({}));
    const dryRun = body.dryRun !== false;
    if (body.interval && !VALID_INTERVALS.includes(body.interval)) {
      return c.json({ error: `invalid interval (one of ${VALID_INTERVALS.join(',')})` }, 400);
    }

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

    // Best-effort cache invalidation. We don't know which (ticker, interval) pairs the
    // delete touched without an extra aggregation; the simplest correct behaviour is
    // to publish a wildcard cache-invalidated message and let subscribers refresh on
    // next read. shared-bars consumers re-read from Mongo on cache miss.
    const redis = await getRedisClient();
    try {
      await redis.publish(CACHE_INVALIDATED_TOPIC, JSON.stringify({ scope: 'bulk', filter, deleted: res.deletedCount, ts: Date.now() }));
    } catch (err) {
      console.warn('[admin] clear-cache publish failed:', err);
    }
    return c.json({ deleted: res.deletedCount, filter });
  });

  // ── Provider info ──────────────────────────────────────────────────────────
  // GET /api/admin/market-data/provider-info
  // Returns the active provider's identity + lookback cap + the poll-interval keys
  // it's willing to serve. The portal calls this once on mount to populate the
  // poll-cadence dropdown and to show which provider is active.
  r.get('/api/admin/market-data/provider-info', (c) => {
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
  // Returns { ticker: count } for every ticker in ohlcv_bars with at least one 5m bar.
  // Used by the portal to badge unresolvable tickers in the history picker so an
  // operator can see at a glance which entries are empty before clicking through.
  r.get('/api/admin/market-data/coverage', async (c) => {
    const db = await getMongoDb();
    const agg = await db
      .collection(COLLECTIONS.OHLCV_BARS)
      .aggregate([
        { $match: { interval: '5m' } },
        { $group: { _id: '$ticker', count: { $sum: 1 } } },
      ])
      .toArray();
    const coverage: Record<string, number> = {};
    for (const row of agg) coverage[row._id as string] = (row as any).count ?? 0;
    return c.json({ coverage });
  });

  // ── Read bars (downsampled view) ───────────────────────────────────────────
  // GET /api/admin/market-data/bars/:ticker?interval=daily&range=60d
  // Returns the cached 5m series for the ticker, downsampled to the requested interval
  // and trimmed to the requested range. Cache miss reads Mongo via shared-bars.getBars
  // and populates the cache.
  r.get('/api/admin/market-data/bars/:ticker', async (c) => {
    const ticker   = c.req.param('ticker');
    const interval = (c.req.query('interval') ?? 'daily') as BarInterval;
    const range    = (c.req.query('range')    ?? '30d')   as RangeKey;
    if (!VALID_INTERVALS.includes(interval)) {
      return c.json({ error: `invalid interval (one of ${VALID_INTERVALS.join(',')})` }, 400);
    }
    if (!VALID_RANGES.includes(range)) {
      return c.json({ error: `invalid range (one of ${VALID_RANGES.join(',')})` }, 400);
    }
    const db    = await getMongoDb();
    const redis = await getRedisClient();
    // getBars currently keys cache by storedInterval — storage is always 5m, so we
    // fetch the 5m series and downsample here. Returning the downsampled view keeps
    // the cache compact (one entry per ticker/range), not bloated per requested-interval.
    const base = await getBars(redis as any, db, ticker, '5m', range);
    const out  = aggregateBars(base, interval);
    return c.json({ ticker, interval, range, bars: out });
  });

  // ── Session calendar endpoints ───────────────────────────────────────────
  // Powers the portal /market-data/calendar page and the source-health panel.
  // calendarDeps is optional only because legacy tests construct the router without
  // calendars; production wiring always passes them. Endpoints 503 when absent.

  r.get('/api/admin/market-data/calendar', async (c) => {
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

  r.get('/api/admin/market-data/holiday-sources', async (c) => {
    if (!calendarDeps) return c.json({ error: 'calendar not configured' }, 503);
    const health = await calendarDeps.holidayCache().getSourceHealth();
    return c.json({ generatedAt: Date.now(), sources: health });
  });

  r.post('/api/admin/market-data/holiday-refresh', async (c) => {
    if (!calendarDeps) return c.json({ error: 'calendar not configured' }, 503);
    await calendarDeps.holidayCache().refreshAll();
    const health = await calendarDeps.holidayCache().getSourceHealth();
    console.log('[market-data] holiday tables refreshed via admin endpoint');
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
export function createInternalBarsRouter(): Hono {
  const r = new Hono();
  const requireStrategy = requireInternalToken('strategy-engine');

  r.get('/internal/bars/:ticker', requireStrategy, async (c) => {
    const ticker   = c.req.param('ticker');
    const interval = (c.req.query('interval') ?? 'daily') as BarInterval;
    const range    = (c.req.query('range')    ?? '30d')   as RangeKey;
    if (!VALID_INTERVALS.includes(interval)) {
      return c.json({ error: `invalid interval (one of ${VALID_INTERVALS.join(',')})` }, 400);
    }
    if (!VALID_RANGES.includes(range)) {
      return c.json({ error: `invalid range (one of ${VALID_RANGES.join(',')})` }, 400);
    }
    const db    = await getMongoDb();
    const redis = await getRedisClient();
    const base = await getBars(redis as any, db, ticker, '5m', range);
    const out  = aggregateBars(base, interval);
    return c.json({ ticker, interval, range, bars: out });
  });

  r.post('/internal/bars', requireStrategy, async (c) => {
    const body = await c.req.json<{
      tickers:  string[];
      interval?: BarInterval;
      range?:    RangeKey;
    }>().catch(() => ({ tickers: [] } as any));
    const tickers  = Array.isArray(body.tickers) ? body.tickers : [];
    const interval = (body.interval ?? 'daily') as BarInterval;
    const range    = (body.range    ?? '30d')   as RangeKey;
    if (!VALID_INTERVALS.includes(interval)) {
      return c.json({ error: `invalid interval (one of ${VALID_INTERVALS.join(',')})` }, 400);
    }
    if (!VALID_RANGES.includes(range)) {
      return c.json({ error: `invalid range (one of ${VALID_RANGES.join(',')})` }, 400);
    }
    if (tickers.length === 0) return c.json({ bars: {} });

    const db    = await getMongoDb();
    const redis = await getRedisClient();
    const out: Record<string, OHLCVBar[]> = {};
    // Per-ticker fetch is cheap because getBars hits Redis on the second-onwards
    // call within a TTL window. We could parallelise with Promise.all if the cache
    // miss path proves slow in production; for now serial is simpler and predictable.
    for (const ticker of tickers) {
      const base = await getBars(redis as any, db, ticker, '5m', range);
      out[ticker] = aggregateBars(base, interval);
    }
    return c.json({ interval, range, bars: out });
  });

  return r;
}
