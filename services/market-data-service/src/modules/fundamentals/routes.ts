// Fundamentals routes. Internal: per-ticker fundamentals for the strategy host (read-through
// cache). Admin: coverage summary + force-refresh, under the existing market-data admin
// namespace. Auth is per-route (parseInternalHeaders / parseAdminHeaders), mirroring the bars
// routers.

import { Hono } from 'hono';
import { parseAdminHeaders, parseInternalHeaders } from '@trader/shared-auth/middleware';
import type { FundamentalsCache } from './application/FundamentalsCache.ts';
import type { FundamentalsRefreshScheduler } from './application/FundamentalsRefreshScheduler.ts';
import type { UniverseManager } from '../universe/application/UniverseManager.ts';
import type { StubAnalystEstimates, AnalystEstimates } from './infrastructure/StubAnalystEstimates.ts';

// Analyst-estimates fetcher seam. The Research Fundamentals tab's analyst panel is display-only and
// optional: when the fetcher returns `null` (the current placeholder — the Yahoo source was dropped
// per epic pit-fundamentals-lake-rearchitecture decision I, with no PIT source wired yet), the
// per-ticker endpoint simply omits the `analyst` block rather than failing the read of the stored
// QMJ line items. The interface is kept so a later PIT-backed provider drops in unchanged.
export interface AnalystEstimatesFetcher {
  fetch(ticker: string): Promise<AnalystEstimates | null>;
}

export function createFundamentalsRouter(
  cache: FundamentalsCache,
  universe: UniverseManager,
  refresher: FundamentalsRefreshScheduler,
  analyst?: AnalystEstimatesFetcher | StubAnalystEstimates,
): Hono {
  const r = new Hono();

  // Internal: fundamentals for the high-velocity strategy host (read-through; refreshes stale).
  r.get('/internal/api/fundamentals', parseInternalHeaders('strategy-engine'), async (c) => {
    const tickers = (c.req.query('tickers') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    if (tickers.length === 0) return c.json({ error: 'tickers query param required (comma-separated)' }, 400);
    const docs = await cache.get(tickers);
    const out: Record<string, unknown> = {};
    for (const [t, d] of Object.entries(docs)) {
      out[t] = { raw: d.raw, ratios: d.ratios, qualityPass: d.qualityPass, marketCapGbp: d.marketCapGbp, asOf: d.asOf };
    }
    return c.json({ fundamentals: out });
  });

  // Admin: coverage summary for the Scanner/Feeds health panel. `coverage()` returns the
  // covered/unavailable split ({ count, covered, unavailable, passing, oldestAsOf }) — `covered` =
  // real rows, `unavailable` = by-design tombstones (non-US / no-EDGAR), `count` = covered +
  // unavailable — relayed verbatim so the panel separates real coverage from by-design gaps.
  r.get('/admin/api/market-data/fundamentals/coverage', parseAdminHeaders, async (c) => {
    return c.json(await cache.coverage());
  });

  // Admin: refresh fundamentals. A full-universe Yahoo walk runs for minutes and would 504 at the
  // ingress, so the no-body case (the portal "Refresh" button) wakes the background refresher and
  // returns immediately — the portal polls /coverage for progress. An explicit (small) ticker list
  // still refreshes synchronously for targeted operator use.
  r.post('/admin/api/market-data/fundamentals/refresh', parseAdminHeaders, async (c) => {
    const body = await c.req.json().catch(() => ({})) as { tickers?: string[] };
    if (body.tickers && body.tickers.length > 0) {
      const written = await cache.refresh(body.tickers);
      return c.json({ ok: true, mode: 'sync', requested: body.tickers.length, written });
    }
    if (universe.activeTickers.length === 0) {
      return c.json({ error: 'no tickers (universe empty and no body.tickers)' }, 400);
    }
    refresher.triggerNow();
    return c.json({ ok: true, mode: 'background', started: true, universeSize: universe.activeTickers.length }, 202);
  });

  // Admin: the stored company_fundamentals (QMJ line items + ratios + market cap) for ONE ticker,
  // plus analyst estimates (currently a stubbed null placeholder — decision I) — the per-symbol
  // Research Fundamentals tab. Registered AFTER the `coverage`/`refresh` literal paths so neither is
  // captured by the `:ticker` param, and it additionally rejects those reserved words for defence in
  // depth. `peek` reads the cached row only (no synchronous provider walk) — a missing row returns
  // nulls (the tab shows "not yet fetched"), never a fabricated 0. The analyst block is additive: a
  // null leaves the stored line items rendering and the tab shows the analyst placeholder.
  r.get('/admin/api/market-data/fundamentals/:ticker', parseAdminHeaders, async (c) => {
    const ticker = (c.req.param('ticker') ?? '').trim();
    if (!ticker || ticker === 'coverage' || ticker === 'refresh') {
      return c.json({ error: 'ticker path param required' }, 400);
    }
    const docs = await cache.peek([ticker]);
    const doc = docs[ticker] ?? null;
    const estimates = analyst ? await analyst.fetch(ticker).catch(() => null) : null;
    return c.json({
      ticker,
      raw:          doc?.raw ?? null,
      ratios:       doc?.ratios ?? null,
      qualityPass:  doc?.qualityPass ?? null,   // null = fundamentals not yet fetched
      marketCapGbp: doc?.marketCapGbp ?? null,
      asOf:         doc?.asOf ?? null,
      source:       doc?.source ?? null,
      // By-design fail-closed marker (Task 8 tombstone): true ⇒ the provider can never resolve this
      // name (non-US fail-closed, or a US no-EDGAR miss). Lets the Research Fundamentals tab render an
      // honest "no fundamentals (by design)" state, distinct from a covered-but-not-yet-fetched row.
      // null = no cached doc at all.
      unavailable:  doc?.unavailable ?? null,
      analyst:      estimates,                  // null = estimates not yet available (placeholder, decision I)
    });
  });

  return r;
}
