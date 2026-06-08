// Market scanner routes — the operator/portal view over the single EODHD-fed universe.
//   POST /admin/api/market-data/scanner/run        → rebuild the universe (runs the EODHD scan)
//   GET  /admin/api/market-data/scanner/snapshot   → per-name table (cap, QMJ ratios, pass/fail)
//   GET  /admin/api/market-data/scanner/feed-health → EODHD credit usage + feed/fundamentals freshness
// Snapshot reads cached fundamentals (peek — no synchronous provider refresh); use the
// fundamentals/refresh admin endpoint or scanner/run to populate.

import { Hono } from 'hono';
import { parseAdminHeaders } from '@trader/shared-auth/middleware';
import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import { getRedisClient } from '@trader/shared-redis';
import { getEodhdClient } from '../bars/infrastructure/providers/eodhd-client.ts';
import type { UniverseManager } from '../universe/application/UniverseManager.ts';
import type { FundamentalsCache } from '../fundamentals/application/FundamentalsCache.ts';

interface RegistryRow { ticker: string; name?: string; market?: string }

export function createScannerRouter(universe: UniverseManager, fundamentals: FundamentalsCache): Hono {
  const r = new Hono();

  r.post('/admin/api/market-data/scanner/run', parseAdminHeaders, async (c) => {
    const tickers = await universe.refresh();
    return c.json({ ok: true, universeSize: tickers.length, sample: tickers.slice(0, 20) });
  });

  r.get('/admin/api/market-data/scanner/snapshot', parseAdminHeaders, async (c) => {
    const tickers = universe.activeTickers;
    const sectors = universe.sectorMap;
    const db = await getMongoDb();
    const regs = await db.collection<RegistryRow>(COLLECTIONS.INSTRUMENT_REGISTRY)
      .find({ ticker: { $in: tickers }, activeTo: null }).toArray();
    const regByTicker = new Map(regs.map((d) => [d.ticker, d]));
    const funds = await fundamentals.peek(tickers);   // cached only — no provider calls

    const rows = tickers.map((t) => {
      const reg = regByTicker.get(t);
      const f = funds[t];
      return {
        ticker:       t,
        name:         reg?.name ?? t,
        market:       reg?.market ?? 'OTHER',
        sector:       sectors[t] ?? 'Unknown',
        marketCapGbp: f?.marketCapGbp ?? null,
        ratios:       f?.ratios ?? null,
        qualityPass:  f?.qualityPass ?? null,           // null = fundamentals not yet fetched
        // Per-name provenance for the portal source badge (#150): `pit-edgar` (US warehouse hit) /
        // `yahoo` (PIT fall-back or yahoo mode) / `eodhd`, as persisted on the cached row. null when
        // fundamentals aren't fetched yet — the badge then shows "none", never a fabricated source.
        source:       f?.source ?? null,
      };
    });
    rows.sort((a, b) => (b.marketCapGbp ?? 0) - (a.marketCapGbp ?? 0));
    return c.json({
      universeSize:     tickers.length,
      qualityKnown:     rows.filter((x) => x.qualityPass !== null).length,
      qualityPassCount: rows.filter((x) => x.qualityPass === true).length,
      rows,
    });
  });

  r.get('/admin/api/market-data/scanner/feed-health', parseAdminHeaders, async (c) => {
    const eodhd = getEodhdClient();
    const cov = await fundamentals.coverage();
    const redis = await getRedisClient();
    const today = new Date().toISOString().slice(0, 10);
    const [usPull, lsePull] = await Promise.all([
      redis.get(`market-data:eodhd-feed:US:${today}`),
      redis.get(`market-data:eodhd-feed:LSE:${today}`),
    ]);
    return c.json({
      eodhd:        { callsUsedToday: eodhd.callsUsedToday, dailyCallLimit: eodhd.dailyCallLimit },
      fundamentals: cov,
      feed:         { date: today, usPulledToday: usPull === '1', lsePulledToday: lsePull === '1' },
      config: {
        universeSource:       process.env.UNIVERSE_SOURCE ?? 'curated',
        dailyHistoryProvider: process.env.DAILY_HISTORY_PROVIDER ?? 'yahoo',
        // EFFECTIVE provider the wired cache runs (the live FUNDAMENTALS_PROVIDER) — `yahoo` today,
        // `pit` once the capstone flips it. Read from the cache, not a re-parse of process.env, so
        // the panel can't drift from the provider actually serving the snapshot's per-name sources.
        fundamentalsProvider: fundamentals.effectiveSource,
        minMarketCapGbp:      Number(process.env.MIN_MARKET_CAP_GBP ?? 5_000_000_000),
      },
    });
  });

  return r;
}
