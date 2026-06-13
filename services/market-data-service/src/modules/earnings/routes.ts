// Earnings calendar admin routes (portal-facing). `upcoming` feeds the /calendar page; `overlap`
// answers "of these (position) tickers, which report within N days" for the dashboard red flag —
// the portal passes its holdings' tickers so market-data stays free of positions coupling.

import { Hono } from 'hono';
import { parseAdminHeaders } from '@trader/shared-auth/middleware';
import type { EarningsStore } from './application/EarningsStore.ts';
import type { EarningsRefreshScheduler } from './application/EarningsRefreshScheduler.ts';
import { earningsOverlap } from './application/overlap.ts';

export function createEarningsRouter(store: EarningsStore, refresher: EarningsRefreshScheduler): Hono {
    const r = new Hono();
    r.use('/admin/api/market-data/earnings/*', parseAdminHeaders);

    r.get('/admin/api/market-data/earnings/upcoming', async (c) => {
        const days = Math.min(365, Math.max(1, Math.trunc(Number(c.req.query('days') ?? 30)) || 30));
        const events = await store.upcoming(days, Date.now());
        return c.json({
            days,
            events: events.map((d) => ({
                ticker: d.ticker,
                nextEarningsDate: d.nextEarningsDate ?? null,
                dividendDate: d.dividendDate ?? null,
                source: d.source,
            })),
        });
    });

    r.get('/admin/api/market-data/earnings/overlap', async (c) => {
        const tickers = (c.req.query('tickers') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const withinDays = Math.min(60, Math.max(1, Math.trunc(Number(c.req.query('days') ?? 10)) || 10));
        const byTicker = await store.peek(tickers);
        return c.json({ withinDays, overlap: earningsOverlap(tickers, byTicker, Date.now(), withinDays) });
    });

    r.get('/admin/api/market-data/earnings/coverage', async (c) => c.json(await store.coverage()));

    r.post('/admin/api/market-data/earnings/refresh', async (c) => {
        refresher.triggerNow();
        return c.json({ ok: true });
    });

    return r;
}
