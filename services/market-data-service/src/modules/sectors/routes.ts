// Sector-rotation performance route (portal-facing, admin-gated). Reads each tracked sector ETF's
// daily series, aggregates to weekly, and returns weekly + trailing returns sorted by trailing
// momentum — the data behind the /sectors heatmap. Resolves db/redis lazily (module-level mount
// has no handle on them), matching the other market-data routes.

import { Hono } from 'hono';
import { parseAdminHeaders } from '@trader/shared-auth/middleware';
import { getBars } from '@trader/shared-bars';
import { getRedisClient } from '@trader/shared-redis';
import { getMongoDb } from '@trader/shared-mongo';
import { sectorEtfTickers, sectorLabel } from './sector-etfs.ts';
import { computeSectorPerf } from './SectorPerformance.ts';

export function createSectorsRouter(): Hono {
    const r = new Hono();

    r.get('/admin/api/market-data/sectors/performance', parseAdminHeaders, async (c) => {
        const weeks = Math.min(52, Math.max(1, Math.trunc(Number(c.req.query('weeks') ?? 13)) || 13));
        const redis = await getRedisClient();
        const db = await getMongoDb();
        const tickers = sectorEtfTickers();
        const rows = await Promise.all(tickers.map(async (ticker) => {
            const bars = await getBars(redis as never, db, ticker, 'daily', '1y');
            return computeSectorPerf(ticker, sectorLabel(ticker), bars, weeks);
        }));
        // Strongest trailing-quarter momentum first — where the long-only hunt should focus.
        rows.sort((a, b) => (b.trailing13w ?? -Infinity) - (a.trailing13w ?? -Infinity));
        return c.json({ weeks, sectors: rows });
    });

    return r;
}
