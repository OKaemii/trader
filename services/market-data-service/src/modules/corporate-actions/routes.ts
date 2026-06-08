// Corporate-actions routes.
//   Admin: GET /admin/api/market-data/corporate-actions?ticker=  — the stored dividend + split lists
//          for one ticker (the corporate-actions list on the History page) + a coverage summary +
//          a force-refresh trigger. Under the existing market-data admin namespace.
//   Internal: GET /internal/api/dividend-yield?tickers=&asOf=  — the point-in-time, backfillable
//          Value dividend-yield leg the strategy factor host injects into HistoryView.fundamentals
//          (§H). Returns one yield per requested ticker as-of the knowledge-time; the factor host
//          (T9) and the research backfill (T17) consume this shape. Auth is per-route
//          (parseAdminHeaders / parseInternalHeaders), mirroring the fundamentals/bars routers.

import { Hono } from 'hono';
import { parseAdminHeaders, parseInternalHeaders } from '@trader/shared-auth/middleware';
import type { CorporateActionsStore, StoredDividend } from './application/CorporateActionsStore.ts';
import type { CorporateActionsRefreshScheduler } from './application/CorporateActionsRefreshScheduler.ts';
import { dividendYieldAsOf } from './application/dividend-yield.ts';

// The host resolves a ticker's BASE-unit daily close at/<= asOf (the yield denominator). Injected so
// the router stays free of the bars read path and is unit-testable; the wiring binds it to getBars.
export type PriceAsOfResolver = (ticker: string, asOfMs: number) => Promise<number | null>;

export function createCorporateActionsRouter(
  store: CorporateActionsStore,
  refresher: CorporateActionsRefreshScheduler,
  priceAsOf: PriceAsOfResolver,
): Hono {
  const r = new Hono();

  // Internal: the dividend-yield leg for the factor host. `asOf` (UTC ms) is the knowledge-time; it
  // defaults to now (the live cycle). For each ticker we compute trailing-12m DPS (from the stored
  // dividends, ex-date <= asOf) over the close at/<= asOf — a unit-consistent, point-in-time yield.
  // A ticker with no price as-of returns `dividendYield: null` (the host omits the leg; never a
  // fabricated 0). Reads only the store + bars this service owns — no cross-service hop.
  r.get('/internal/api/dividend-yield', parseInternalHeaders('strategy-engine', 'fundamentals-api'), async (c) => {
    const tickers = (c.req.query('tickers') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    if (tickers.length === 0) return c.json({ error: 'tickers query param required (comma-separated)' }, 400);
    const asOfRaw = Number(c.req.query('asOf'));
    const asOfMs = Number.isFinite(asOfRaw) && asOfRaw > 0 ? asOfRaw : Date.now();

    const dividendsByTicker = await store.dividendsForMany(tickers);
    // Price lookups are independent read-through (Redis-cached) bar reads — resolve them in parallel
    // rather than serializing the whole universe per cycle.
    const entries = await Promise.all(tickers.map(async (ticker) => {
      const divs: StoredDividend[] = dividendsByTicker[ticker] ?? [];
      const price = await priceAsOf(ticker, asOfMs);
      return [ticker, { dividendYield: dividendYieldAsOf(divs, price, asOfMs) }] as const;
    }));
    return c.json({ asOf: asOfMs, dividendYields: Object.fromEntries(entries) });
  });

  r.use('/admin/api/market-data/corporate-actions/*', parseAdminHeaders);

  // Admin: coverage summary for the feed-health panel. (Auth already applied by the /* use above.)
  r.get('/admin/api/market-data/corporate-actions/coverage', async (c) => c.json(await store.coverage()));

  // Admin: force an incremental re-sync of the active universe (the portal "Refresh" button). The
  // pass runs in the background refresher (it's near-free when current); returns immediately.
  r.post('/admin/api/market-data/corporate-actions/refresh', async (c) => {
    refresher.triggerNow();
    return c.json({ ok: true });
  });

  // Admin: the stored dividend + split lists for one ticker (the History corporate-actions list).
  r.get('/admin/api/market-data/corporate-actions', parseAdminHeaders, async (c) => {
    const ticker = (c.req.query('ticker') ?? '').trim();
    if (!ticker) return c.json({ error: 'ticker query param required' }, 400);
    const doc = await store.peek(ticker);
    return c.json({
      ticker,
      dividends: doc?.dividends ?? [],
      splits: doc?.splits ?? [],
      lastDividendDate: doc?.lastDividendDate ?? null,
      lastSplitDate: doc?.lastSplitDate ?? null,
      asOf: doc?.asOf ?? null,
    });
  });

  return r;
}
