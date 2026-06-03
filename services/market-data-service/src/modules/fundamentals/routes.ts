// Fundamentals routes. Internal: per-ticker fundamentals for the strategy host (read-through
// cache). Admin: coverage summary + force-refresh, under the existing market-data admin
// namespace. Auth is per-route (parseInternalHeaders / parseAdminHeaders), mirroring the bars
// routers.

import { Hono } from 'hono';
import { parseAdminHeaders, parseInternalHeaders } from '@trader/shared-auth/middleware';
import type { FundamentalsCache } from './application/FundamentalsCache.ts';
import type { UniverseManager } from '../universe/application/UniverseManager.ts';

export function createFundamentalsRouter(cache: FundamentalsCache, universe: UniverseManager): Hono {
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

  // Admin: coverage summary for the Scanner/Feeds health panel.
  r.get('/admin/api/market-data/fundamentals/coverage', parseAdminHeaders, async (c) => {
    return c.json(await cache.coverage());
  });

  // Admin: force a refresh of the given tickers (or the whole active universe when none given).
  r.post('/admin/api/market-data/fundamentals/refresh', parseAdminHeaders, async (c) => {
    const body = await c.req.json().catch(() => ({})) as { tickers?: string[] };
    const tickers = (body.tickers && body.tickers.length > 0) ? body.tickers : universe.activeTickers;
    if (tickers.length === 0) return c.json({ error: 'no tickers (universe empty and no body.tickers)' }, 400);
    const written = await cache.refresh(tickers);
    return c.json({ ok: true, requested: tickers.length, written });
  });

  return r;
}
