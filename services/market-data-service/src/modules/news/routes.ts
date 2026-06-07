// News routes.
//   Admin: GET /admin/api/market-data/news?ticker=  — the stored news articles for one ticker
//          (the Overview "Recent Events" panel + the narrative/"Why?" event context; T24/T30/T35
//          consume this). On a symbol open this also kicks a LAZY background sync of that ticker
//          (fire-and-forget, gated by the store's daily TTL — never per page-load), so the first
//          open of a stale symbol freshens it for the next read without blocking the response.
//   Also under the market-data admin namespace: a coverage summary + a force-refresh trigger.
// Auth is per-route (parseAdminHeaders), mirroring the corporate-actions/earnings routers.

import { Hono } from 'hono';
import { parseAdminHeaders } from '@trader/shared-auth/middleware';
import type { NewsStore } from './application/NewsStore.ts';
import type { NewsRefreshScheduler } from './application/NewsRefreshScheduler.ts';
import { log } from '../../logger.ts';

export function createNewsRouter(store: NewsStore, refresher: NewsRefreshScheduler): Hono {
  const r = new Hono();

  r.use('/admin/api/market-data/news/*', parseAdminHeaders);

  // Admin: coverage summary for the feed-health panel. (Auth applied by the /* use above.)
  r.get('/admin/api/market-data/news/coverage', async (c) => c.json(await store.coverage()));

  // Admin: force a full incremental re-sync of the active universe (the portal "Refresh" button).
  // The pass runs in the background refresher (near-free when current); returns immediately.
  r.post('/admin/api/market-data/news/refresh', async (c) => {
    refresher.triggerNow();
    return c.json({ ok: true });
  });

  // Admin: the stored news articles for one ticker, newest-first. Returns whatever the background
  // sync has accreted (a read NEVER blocks on a fetch). On open, fire-and-forget a lazy sync of THIS
  // ticker so a stale symbol freshens for next time — the store's daily TTL gate makes a current
  // symbol a no-op, so this is safe to call on every open.
  r.get('/admin/api/market-data/news', parseAdminHeaders, async (c) => {
    const ticker = (c.req.query('ticker') ?? '').trim();
    if (!ticker) return c.json({ error: 'ticker query param required' }, 400);

    const doc = await store.peek(ticker);

    // Lazy on-open freshen — never awaited, never blocks the read. TTL-gated + budget-degrading, so a
    // current symbol costs nothing and an exhausted budget appends nothing (the client returns []).
    void store.syncOne(ticker).catch((err) => {
      log.warn(`[news] lazy sync of ${ticker} failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    const articles = doc
      ? [...doc.articles].sort((a, b) => b.date.localeCompare(a.date))
      : [];
    return c.json({
      ticker,
      articles,
      lastFetchedDate: doc?.lastFetchedDate ?? null,
      asOf: doc?.asOf ?? null,
    });
  });

  return r;
}
