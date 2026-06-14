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
import {
  type UniverseManager, type OverridesDoc, type OverrideEntry, type BareForcedAdd,
  identitiesToTickers, indexT212ByMarket, resolveForcedAdd, resolveForcedRemove,
} from '../universe/application/UniverseManager.ts';
import { MongoInstrumentMeta } from '../universe/infrastructure/MongoInstrumentMeta.ts';
import { fetchT212Instruments } from '../universe/infrastructure/t212-client.ts';
import { tryIdentityOf, tickerOf } from '../../shared/identity.ts';
import type { MarketDataProvider } from '../bars/infrastructure/providers/market-data-provider.ts';
import { aggregateBars, getBars, getBarAtOrBefore, getDailyDepth, countAllBars, countRevisionsForTickers, getRevisionsForTicker, invalidateBars, type RangeKey } from '@trader/shared-bars';
import { Trading212TickerAdapter } from '@trader/ticker-identity';
import { backfillTickers, CACHE_INVALIDATED_TOPIC } from '../bars/infrastructure/backfill.ts';
import { backfillDailyHistory } from '../bars/infrastructure/daily-history.ts';
import { foldDailyEmit } from '../bars/infrastructure/daily-emit.ts';
import { REDIS_STREAMS, POLL_INTERVAL_OPTIONS, type BarInterval, type OHLCVBar, type PollIntervalKey } from '@trader/shared-types';
import type { HolidayCache, ExchangeCalendar, Market } from '@trader/shared-calendar';
import { scheduleBetween, marketStateOf } from '@trader/shared-calendar';

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

// The curated-US subset of the active universe — the names whose deep daily series the PIT
// market-cap / momentum reads depend on (the EDGAR-fundamentals coverage set is US-only too). A
// US T212 ticker is the `_US_EQ` suffix; LSE (`l_EQ`) and any other suffix are excluded (no deep
// US daily-series claim there). Used by the depth-check + deep-backfill driver when the caller
// doesn't pass an explicit `tickers` list. Pure (testable) — selection only, no I/O.
export function curatedUsTickers(activeTickers: string[]): string[] {
  return activeTickers.filter((t) => /_US_EQ$/.test(t));
}

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
    // portal_universe_overrides stores adds/removes as { symbol, market } objects since Task 16b —
    // re-derive the T212 strings for the response so the portal contract (string[] adds/removes) is
    // unchanged (the bare-forced-add UX is Task 18/21).
    const doc = await db.collection<OverridesDoc>(COLLECTIONS.PORTAL_UNIVERSE_OVERRIDES)
      .findOne({ _id: 'singleton' });
    const adds = identitiesToTickers(doc?.adds);
    const removes = identitiesToTickers(doc?.removes);

    // Enrich the active universe from instrument_registry so the portal can render market + ADV per
    // ticker. The registry is keyed on (symbol, market) since Task 16b — query by the split identities
    // and re-key the result map back to the T212 ticker. Fall back to bare tickers if the registry is
    // empty (cold start before first refresh). The activeUniverse string array is kept for backwards-
    // compat with anything that still treats it as `string[]`.
    type RegistryDoc = { symbol?: string; market?: string; name?: string; sector?: string; adv?: number };
    const activeTickers = universeManager.activeTickers;
    const activeIds = activeTickers
      .map((t) => ({ ticker: t, id: tryIdentityOf(t) }))
      .filter((x): x is { ticker: string; id: NonNullable<typeof x.id> } => x.id !== null);
    const registry = activeIds.length === 0 ? [] : await db.collection<RegistryDoc>(COLLECTIONS.INSTRUMENT_REGISTRY)
      .find({ $or: activeIds.map((x) => ({ symbol: x.id.symbol, market: x.id.market })), activeTo: null })
      .project({ _id: 0, symbol: 1, market: 1, name: 1, sector: 1, adv: 1 })
      .toArray();
    const byTicker = new Map<string, RegistryDoc>();
    for (const reg of registry as RegistryDoc[]) {
      if (reg.symbol == null || reg.market == null) continue;
      byTicker.set(tickerOf(reg.symbol, reg.market), reg);
    }
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
      adds,
      removes,
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
      // Forced-adds accept the BARE form since Task 18 — a bare symbol (`'GOOGL'`), a
      // `{ symbol, market? }` object (market defaults to US), or a legacy T212 string for back-compat.
      // A bare add is resolved against the live T212 catalog with the US-preferred cross-listing rule
      // (reusing the universe-build resolution), so the stored identity is the tradable listing — an
      // unresolvable symbol is dropped (never persisted as a phantom). Removes don't gate on the
      // catalog (a delisted name can still be removed). Both persist as { symbol, market } (Task 16b).
      let catalogLoaded = true;
      let index = indexT212ByMarket([]);
      try {
        index = indexT212ByMarket(await fetchT212Instruments());
      } catch (err) {
        // Catalog fetch failed (T212 throttle/hang) — fall back to a bare-resolve that can't verify
        // tradability (an explicit/defaulted market identity is still derivable for a forced add).
        catalogLoaded = false;
        logger.warn({ err }, '[universe] forced-add resolution: T212 catalog unavailable, resolving without tradability check');
      }
      // With the catalog loaded, gate each add on a real listing (resolveForcedAdd); without it, still
      // honour the operator's forced add by deriving the identity (resolveForcedRemove = no catalog gate).
      const resolveAdd = (raw: BareForcedAdd): OverrideEntry | null =>
        catalogLoaded ? resolveForcedAdd(raw, index) : resolveForcedRemove(raw);
      const dedup = (entries: OverrideEntry[]): OverrideEntry[] => {
        const seen = new Set<string>();
        return entries.filter((e) => { const k = `${e.symbol}|${e.market}`; if (seen.has(k)) return false; seen.add(k); return true; });
      };
      const addEntries = dedup(
        (body.adds ?? []).map(resolveAdd).filter((e): e is OverrideEntry => e !== null),
      );
      const removeEntries = dedup(
        (body.removes ?? []).map(resolveForcedRemove).filter((e): e is OverrideEntry => e !== null),
      );
      const db = await getMongoDb();
      await db.collection(COLLECTIONS.PORTAL_UNIVERSE_OVERRIDES).updateOne(
        { _id: 'singleton' as any },
        { $set: { adds: addEntries, removes: removeEntries, updatedBy: body.userId ?? 'unknown', updatedAt: new Date() } },
        { upsert: true },
      );
      // Echo back T212 strings (the byte-unchanged portal contract until Task 21 flips it to bare).
      return c.json({
        ok: true,
        adds: identitiesToTickers(addEntries),
        removes: identitiesToTickers(removeEntries),
      });
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
        forceRefetch: body.force ?? false,
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
  // body: { tickers?: string[], years?: number, scope?: 'active'|'curated-us', deep?: boolean, force?: boolean }
  // Seeds the persisted interval:'daily' series that strategy lookbacks + the PIT market-cap read
  // (12-1 momentum, adjusted-close-at). Yahoo-sourced + free, decoupled from the metered 5m provider.
  //
  // This IS the capstone's operator-gated DEEP-backfill driver — it only runs when called (no cron),
  // and it drives the EXISTING gap-aware backfillDailyHistory, so each missing daily date is fetched
  // ONCE then costs zero on a re-run (idempotent). The operator seeds the full curated-US deep series
  // to ~2006/1993 with:
  //   POST /admin/api/market-data/backfill-daily  { "scope": "curated-us", "deep": true }
  //     → scope picks the curated-US subset of the active universe; deep defaults years to
  //       DAILY_BACKFILL_YEARS (35 → SPY's 1993 inception). Verify depth after via
  //       GET /admin/api/market-data/daily-depth.
  // Selection precedence: explicit body.tickers > scope ('curated-us' | 'active') > active universe.
  // Depth: body.years > (deep || curated-us ⇒ DAILY_BACKFILL_YEARS) > backfillDailyHistory's default.
  r.post(
    '/admin/api/market-data/backfill-daily',
    zValidator('json', MarketDataContracts.BackfillDailyRequestSchema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid body', issues: result.error.issues }, 400);
    }),
    async (c) => {
      const body = c.req.valid('json');
      // Selection: explicit list wins; else scope chooses the curated-US subset or the whole universe.
      const tickers = body.tickers && body.tickers.length > 0
        ? body.tickers
        : body.scope === 'curated-us'
          ? curatedUsTickers(universeManager.activeTickers)
          : universeManager.activeTickers;
      if (tickers.length === 0) {
        const why = body.scope === 'curated-us'
          ? 'no curated-US names in the active universe'
          : 'universe empty';
        return c.json({ error: `no tickers (${why} and no body.tickers)` }, 400);
      }
      // Deep mode (explicit `deep`, or implied by the curated-US deep-backfill scope) seeds the full
      // series: default years to DAILY_BACKFILL_YEARS when the caller didn't pin one. An explicit
      // body.years always wins. Falls through to backfillDailyHistory's own default otherwise.
      const deep = body.deep === true || body.scope === 'curated-us';
      const years = body.years
        ?? (deep ? Number(process.env.DAILY_BACKFILL_YEARS ?? 35) : undefined);
      const db = await getMongoDb();
      const redis = await getRedisClient();
      const results = await backfillDailyHistory(db, redis, tickers, {
        ...(years !== undefined ? { years } : {}),
        forceRefetch: body.force ?? false,
      });
      return c.json({
        scope:   body.scope ?? 'active',
        deep,
        years:   years ?? null,
        tickers: results.length,
        bars:    results.reduce((acc, r) => acc + r.upserted, 0),
        failures: results.filter((r) => r.error).length,
        results,
      });
    },
  );

  // ── On-demand daily emit (operator-gated, BYPASSES the session-close NX gate) ──
  // POST /api/admin/market-data/daily-emit/force
  // body: { market?: 'US'|'LSE', date?: 'YYYY-MM-DD' }
  // Folds a UTC day's persisted 5m bars into daily bars and publishes them to
  // market:raw:daily — the same read→group→aggregate→persist→publish fold the
  // session-close path runs (foldDailyEmit), but WITHOUT the once-per-(market, UTC-date)
  // NX gate, so the operator can (re-)emit a missed/past day on demand. This is the RC1 QA
  // hook that revives the strategy→PIT chain after a wipe (proving pit_served>0 end-to-end)
  // without waiting for the next real NYSE/LSE close.
  //   market omitted → both US + LSE (each market's active-universe subset by T212 suffix);
  //                     a value narrows to that one market.
  //   date   omitted → today (UTC); a past YYYY-MM-DD folds ONLY that single UTC day (the
  //                     5m read is floored at the day's UTC-midnight and capped at the next
  //                     UTC-midnight so a deep 5m series doesn't fold into the wrong day).
  // Returns { emitted: <total daily bar count>, market, date }. emitted:0 (never an error)
  // when no 5m bars exist for that day — an empty day is a valid no-op, not a failure.
  r.post(
    '/admin/api/market-data/daily-emit/force',
    zValidator('json', MarketDataContracts.DailyEmitForceRequestSchema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid body', issues: result.error.issues }, 400);
    }),
    async (c) => {
      const body = c.req.valid('json');
      // UTC-day window: [midnight of `date`, midnight of the next day). Default to today (UTC).
      // The lower bound (sinceTs) is the load-bearing OOM-safe floor for the Timescale 5m read;
      // the exclusive upper bound trims a past date's fold to its single day.
      const utcDate = body.date ?? new Date().toISOString().slice(0, 10);
      const sinceTs = Date.parse(`${utcDate}T00:00:00.000Z`);
      const upperBoundTs = sinceTs + 24 * 60 * 60_000;
      // Resolve the active-universe tickers for the requested market(s). US is the `_US_EQ`
      // suffix, LSE the `l_EQ` suffix — the same routing the poll partition + curatedUsTickers
      // use. `market` omitted ⇒ both.
      const markets: Market[] = body.market ? [body.market] : ['US', 'LSE'];
      const active = universeManager.activeTickers;
      const tickersFor = (m: Market): string[] =>
        m === 'US' ? active.filter((t) => /_US_EQ$/.test(t)) : active.filter((t) => /l_EQ$/.test(t));

      const db = await getMongoDb();
      const redis = await getRedisClient();
      let emitted = 0;
      for (const m of markets) {
        const tickers = tickersFor(m);
        if (tickers.length === 0) continue;
        const res = await foldDailyEmit(redis, db, tickers, sinceTs, upperBoundTs);
        emitted += res.emitted;
        logger.info(
          { market: m, date: utcDate, emitted: res.emitted },
          `[market-data] daily-emit/force ${m} ${utcDate}: ${res.emitted} bars → market:raw:daily`,
        );
      }
      return c.json({ emitted, market: body.market ?? 'ALL', date: utcDate });
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
  //
  // STORE NOTE (RC4 audit, card 218). This is a Mongo-targeted maintenance WRITE (deleteMany on
  // the Mongo `ohlcv_bars` collection), not a bar read — correct as-is. It deliberately scopes to
  // the Mongo collection (the legacy `timestamp` Date field filter is Mongo-shaped), so it must
  // NOT be routed through the `BARS_BACKEND` dispatcher. A Timescale equivalent (truncate/delete on
  // the hypertable) would be a separate operator tool if ever needed; out of scope here.
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
  // flag tickers the provider has been actively revising.
  //
  // STORE: both reads are `BARS_BACKEND`-dispatched (`countAllBars` over `bars`; `countRevisionsForTickers`
  // over the revision ledger), so this "what's persisted" view reflects the store the writer writes to.
  // The revision ledger lives in the SAME store as the bars writer writes it — Mongo `bar_revisions_log`
  // on the mongo path, the Timescale `bar_revisions_log` hypertable on the timescale path — so post the
  // writer flip the revisions column reads Timescale, not an empty Mongo ledger. The 5m count is bounded
  // by the provider's ~60d 5m cap (75d window) for Timescale lock safety.
  r.get('/admin/api/market-data/coverage', async (c) => {
    const db = await getMongoDb();
    // Storage is keyed on the bare identity (symbol, market); the dispatched reads return Maps keyed
    // `symbol|market`; re-derive the T212 ticker for the operator-facing coverage map keys.
    const adapter = new Trading212TickerAdapter();
    const tickerOf = (key: string): string | null => {
      const [symbol, market] = key.split('|');
      try { return adapter.toT212({ symbol: symbol ?? '', market: (market ?? '') as 'US' | 'LSE' }); }
      catch { return null; }
    };
    // 5m is provider-capped at ~60d; the 75d floor keeps the dispatched Timescale aggregate pruned to a
    // bounded chunk slice while still counting every extant 5m bar.
    const sinceMs = Date.now() - 75 * 24 * 60 * 60_000;
    const [obsCounts, revCounts] = await Promise.all([
      countAllBars(db, '5m', sinceMs),
      countRevisionsForTickers(db, '5m'),
    ]);
    const coverage: Record<string, { count: number; revisions: number }> = {};
    for (const [key, count] of obsCounts) {
      const k = tickerOf(key);
      if (k === null) continue;
      coverage[k] = { count, revisions: 0 };
    }
    for (const [key, revisions] of revCounts) {
      const k = tickerOf(key);
      if (k === null) continue;
      if (coverage[k]) coverage[k].revisions = revisions;
      else coverage[k] = { count: 0, revisions };
    }
    return c.json({ coverage });
  });

  // ── Daily-series depth (oldest observation + count, per curated-US name) ─────
  // GET /api/admin/market-data/daily-depth[?tickers=A_US_EQ,B_US_EQ][&interval=daily]
  // Proves how far back the persisted daily series reaches for each curated-US name — the
  // depth-check the capstone deep-backfill is verified against. Returns
  // { interval, tickers, depth: { ticker: { oldest, count } } } where `oldest` is the minimum
  // unsuperseded observation_ts (UTC ms, null = no daily bars) and `count` is the unsuperseded
  // row total. Omit `tickers` to probe the curated-US subset of the active universe; pass an
  // explicit list for an ad-hoc check.
  //
  // OOM-safety is the whole point: this does NOT run the `range='max'` / unbounded-aggregate read
  // that exhausted Timescale's lock table (NVIDIA £0). getDailyDepth walks bounded time windows so
  // no single query plan spans the whole hypertable — see @trader/shared-bars getDailyDepthPg.
  r.get('/admin/api/market-data/daily-depth', async (c) => {
    const interval = (c.req.query('interval') ?? 'daily') as BarInterval;
    if (!VALID_INTERVALS.includes(interval)) {
      return c.json({ error: `invalid interval (one of ${VALID_INTERVALS.join(',')})` }, 400);
    }
    const tickersRaw = c.req.query('tickers');
    const tickers = tickersRaw && tickersRaw.trim() !== ''
      ? tickersRaw.split(',').map((t) => t.trim()).filter(Boolean)
      : curatedUsTickers(universeManager.activeTickers);
    if (tickers.length === 0) {
      return c.json({ error: 'no tickers (no curated-US names in the active universe and no ?tickers=)' }, 400);
    }
    const db = await getMongoDb();
    const depth: Record<string, { oldest: number | null; count: number }> = {};
    // Serial, not parallelised: each name's read already walks several bounded windows; running them
    // one ticker at a time keeps the concurrent chunk-lock footprint minimal (the conservative choice
    // for the read that the prior OOM came from). The depth audit is operator-driven, not a hot path.
    for (const ticker of tickers) {
      depth[ticker] = await getDailyDepth(db, ticker, interval);
    }
    return c.json({ interval, tickers: tickers.length, depth });
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
  //
  // STORE: dispatched via `getRevisionsForTicker`, so it reads the revision ledger the bars writer
  // writes to — post the writer flip that is the Timescale `bar_revisions_log`, not an empty Mongo one.
  r.get('/admin/api/market-data/revisions/:ticker', async (c) => {
    const ticker = c.req.param('ticker');
    const sinceRaw = c.req.query('since');
    const limitRaw = c.req.query('limit');
    const since = sinceRaw != null ? Number(sinceRaw) : 0;
    const limit = Math.min(500, Math.max(1, limitRaw != null ? Number(limitRaw) : 100));
    if (!Number.isFinite(since) || since < 0) {
      return c.json({ error: 'since must be a non-negative integer (UTC ms)' }, 400);
    }
    // The ledger is keyed on the bare identity (symbol, market); split the T212 path param.
    // A malformed/non-US-LSE ticker is a client error (400), not a 500.
    let symbol: string, market: string;
    try { ({ symbol, market } = new Trading212TickerAdapter().fromT212(ticker)); }
    catch { return c.json({ error: `unrecognised ticker: ${ticker}` }, 400); }
    const db = await getMongoDb();
    const rows = await getRevisionsForTicker(db, symbol, market, since, limit);
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


  r.get('/internal/api/market-data/bars/:ticker', parseInternalHeaders('strategy-engine', 'fundamentals-api'), async (c) => {
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
    parseInternalHeaders('strategy-engine', 'fundamentals-api'),
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

  // Single adjusted-close-at-or-before read for many tickers — the OOM-safe input fundamentals-api's
  // PIT market-cap / dividend-yield enrichment uses INSTEAD of POSTing the bars batch with
  // range='max' and picking the latest bar from a deep series client-side. For each ticker we take
  // the close of the single latest daily bar at/<= asOf (getBarAtOrBefore — a DESC LIMIT-1 read with
  // NO now-anchored lower bound, so it reaches a 2006 as-of without the chunk-fanning scan that
  // exhausted Timescale's lock table → 'out of shared memory' → a 500). The persisted daily `close`
  // IS the adjusted close (the total-return series momentum differences), so the returned number is
  // literally what momentum sees — the same identity the market-cap arithmetic needs. A name with no
  // qualifying bar (unseeded daily series / nothing <= asOf) returns null → the caller's market cap is
  // then ABSENT (never fabricated). `fundamentals-api` is an allowed caller (mirrors the bars routes);
  // a 403 here would surface as a 500 to the user when the enrichment runs.
  r.post(
    '/internal/api/market-data/adjusted-close-at',
    parseInternalHeaders('strategy-engine', 'fundamentals-api'),
    zValidator('json', MarketDataContracts.AdjustedCloseAtRequestSchema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid body', issues: result.error.issues }, 400);
    }),
    async (c) => {
      const body = c.req.valid('json');
      const interval = body.interval ?? 'daily';
      const asOf     = body.asOf;
      const opts = asOf !== undefined ? { asOf } : {};

      const db    = await getMongoDb();
      const redis = await getRedisClient();
      const closes: Record<string, number | null> = {};
      // Per-ticker single-row reads are cheap and Redis-cached; serial keeps it predictable.
      for (const ticker of body.tickers) {
        const bar = await getBarAtOrBefore(redis as never, db, ticker, interval, opts);
        closes[ticker] = bar && Number.isFinite(bar.close) ? bar.close : null;
      }
      return c.json({ interval, asOf: asOf ?? null, closes });
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
