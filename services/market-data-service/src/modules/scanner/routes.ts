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
import { tryIdentityOf, tickerOf } from '../../shared/identity.ts';

interface RegistryRow { symbol?: string; market?: string; name?: string }

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
    // The registry is keyed on (symbol, market) since Task 16b — query by the split identities and
    // re-key the result map back to the T212 ticker the active set / sectorMap / fundamentals use.
    const ids = tickers
      .map((t) => ({ ticker: t, id: tryIdentityOf(t) }))
      .filter((x): x is { ticker: string; id: NonNullable<typeof x.id> } => x.id !== null);
    // Keep the parsed identity per ticker so each snapshot row can carry the BARE (symbol, market) the
    // portal displays (RC5) without re-parsing — the T212 string stays the runtime key (sort/join),
    // but the operator sees `STAN`/`AAPL` + a market badge, not the reconstructed `STANl_EQ`.
    const idByTicker = new Map(ids.map((x) => [x.ticker, x.id]));
    const regs = ids.length === 0 ? [] : await db.collection<RegistryRow>(COLLECTIONS.INSTRUMENT_REGISTRY)
      .find({ $or: ids.map((x) => ({ symbol: x.id.symbol, market: x.id.market })), activeTo: null }).toArray();
    const regByTicker = new Map<string, RegistryRow>();
    for (const d of regs as RegistryRow[]) {
      if (d.symbol == null || d.market == null) continue;
      regByTicker.set(tickerOf(d.symbol, d.market), d);
    }
    const funds = await fundamentals.peek(tickers);   // cached only — no provider calls

    const rows = tickers.map((t) => {
      const reg = regByTicker.get(t);
      const id = idByTicker.get(t);
      const f = funds[t];
      return {
        // `ticker` is the runtime/wire T212 form, retained for cross-links (the research drawer opens
        // on the canonical id) — the portal display reads `symbol`/`market` instead (RC5).
        ticker:       t,
        // Bare exchange identity from the adapter (the registry is keyed on it). `symbol` falls back
        // to the T212 string only for an un-routable name (shouldn't occur for an active ticker);
        // `market` prefers the parsed identity, then the registry row, then 'OTHER'.
        symbol:       id?.symbol ?? t,
        market:       id?.market ?? reg?.market ?? 'OTHER',
        name:         reg?.name ?? id?.symbol ?? t,
        sector:       sectors[t] ?? 'Unknown',
        marketCapGbp: f?.marketCapGbp ?? null,
        ratios:       f?.ratios ?? null,
        qualityPass:  f?.qualityPass ?? null,           // null = fundamentals not yet fetched
        // By-design fail-closed marker (Task 8 tombstone): true ⇒ the provider can NEVER resolve this
        // name (non-US fail-closed, or a US no-EDGAR miss). The portal renders "no fundamentals (by
        // design)" for it — visually distinct from a covered-but-pending `—`. Absent/false ⇒ a real
        // (or not-yet-fetched) row. null when there's no cached doc at all.
        unavailable:  f?.unavailable ?? null,
        // Per-name provenance for the portal source badge (#150): `pit-edgar` (US warehouse hit) /
        // `yahoo` (PIT fall-back or yahoo mode) / `eodhd`, as persisted on the cached row. null when
        // fundamentals aren't fetched yet — the badge then shows "none", never a fabricated source.
        source:       f?.source ?? null,
      };
    });
    // Headline cap-sort is unchanged; the portal re-sorts client-side (now by `symbol`, not `ticker`).
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
    // coverage() carries the covered/unavailable split: `covered` = real rows, `unavailable` =
    // by-design tombstones (non-US / no-EDGAR), `count` = covered + unavailable. Relayed verbatim so
    // the portal renders "covered vs by-design-unavailable" honestly instead of lumping tombstones
    // (qualityPass:false) into the headline count.
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
        dailyHistoryProvider: process.env.DAILY_HISTORY_PROVIDER ?? 'eodhd',
        // EFFECTIVE provider the wired cache runs (the live FUNDAMENTALS_PROVIDER) — `pit` (the PIT
        // lake) by default. Read from the cache, not a re-parse of process.env, so the panel can't
        // drift from the provider actually serving the snapshot's per-name sources.
        fundamentalsProvider: fundamentals.effectiveSource,
        minMarketCapGbp:      Number(process.env.MIN_MARKET_CAP_GBP ?? 5_000_000_000),
      },
    });
  });

  return r;
}
