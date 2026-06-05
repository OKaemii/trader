// Swing-screener admin routes (portal-facing, admin-gated). `latest` feeds the /screener table;
// `run` is the on-demand "Run now" button; `thresholds` GET/PUT tunes the screen without redeploy.

import { Hono } from 'hono';
import { parseAdminHeaders } from '@trader/shared-auth/middleware';
import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import type { SwingScreener } from './SwingScreener.ts';
import { getScreenerThresholds, invalidateScreenerThresholds } from './SwingScreener.ts';

export function createScreenerRouter(screener: SwingScreener): Hono {
    const r = new Hono();

    r.get('/admin/api/market-data/screener/latest', parseAdminHeaders, async (c) => {
        const snap = await screener.latest();
        return c.json(snap ?? { runAt: null, rows: [], scanned: 0 });
    });

    r.post('/admin/api/market-data/screener/run', parseAdminHeaders, async (c) =>
        c.json(await screener.run()));

    r.get('/admin/api/market-data/screener/thresholds', parseAdminHeaders, async (c) =>
        c.json(await getScreenerThresholds()));

    r.put('/admin/api/market-data/screener/thresholds', parseAdminHeaders, async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const db = await getMongoDb();
        await db.collection(COLLECTIONS.PORTAL_RUNTIME_CONFIG).updateOne(
            { _id: 'swing_screener' as never },
            { $set: { thresholds: body, updatedAt: Date.now() } },
            { upsert: true },
        );
        invalidateScreenerThresholds();   // getScreenerThresholds re-clamps on next read
        return c.json(await getScreenerThresholds());
    });

    return r;
}
