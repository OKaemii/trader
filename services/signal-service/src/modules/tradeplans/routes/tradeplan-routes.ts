// Trade-plan CRUD + enriched-positions read (portal-facing, admin-gated). The portal
// /positions panel reads positions/enriched; the editor PUT/DELETEs per-ticker plans.

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { parseAdminHeaders } from '@trader/shared-auth/middleware';
import { Trading, type TradingServiceClient } from '@trader/contracts';
import type { ITradePlanRepository } from '../domain/TradePlan.ts';
import type { ISignalRepository } from '../../signals/domain/ISignalRepository.ts';
import { enrichPosition } from '../application/EnrichedPositions.ts';

export interface TradePlanRouterDeps {
    tradePlanRepo: ITradePlanRepository;
    signalRepo: ISignalRepository;
    tradingClient: TradingServiceClient;
    now?: () => number;
}

export function createTradePlanRouter(deps: TradePlanRouterDeps): Hono {
    const r = new Hono();
    const now = deps.now ?? (() => Date.now());

    r.get('/admin/api/signals/trade-plans', parseAdminHeaders, async (c) =>
        c.json({ plans: await deps.tradePlanRepo.list() }));

    r.get('/admin/api/signals/trade-plans/:ticker', parseAdminHeaders, async (c) => {
        const ticker = c.req.param('ticker');
        if (!ticker) return c.json({ error: 'missing ticker' }, 400);
        const plan = await deps.tradePlanRepo.get(ticker);
        return plan ? c.json(plan) : c.json({ error: 'no trade plan' }, 404);
    });

    r.put(
        '/admin/api/signals/trade-plans/:ticker',
        parseAdminHeaders,
        zValidator('json', Trading.TradePlanRequestSchema),
        async (c) => {
            const ticker = c.req.param('ticker');
            if (!ticker) return c.json({ error: 'missing ticker' }, 400);
            const body = c.req.valid('json');
            const plan = await deps.tradePlanRepo.upsert({
                ticker,
                stop: body.stop,
                target: body.target,
                note: body.note,
                updatedBy: body.updatedBy ?? 'unknown',
                updatedAt: now(),
            });
            return c.json(plan);
        },
    );

    r.delete('/admin/api/signals/trade-plans/:ticker', parseAdminHeaders, async (c) => {
        const ticker = c.req.param('ticker');
        if (!ticker) return c.json({ error: 'missing ticker' }, 400);
        const removed = await deps.tradePlanRepo.remove(ticker);
        return c.json({ removed });
    });

    // Live positions joined with entry/days-held + trade plan + derived R-multiple/stop distance.
    r.get('/admin/api/signals/positions/enriched', parseAdminHeaders, async (c) => {
        const { positions } = await deps.tradingClient.getPositions();
        const t = now();
        const rows = await Promise.all(positions.map(async (pos) => {
            const [openBuys, plan] = await Promise.all([
                deps.signalRepo.findOpenBuysByTicker(pos.ticker),
                deps.tradePlanRepo.get(pos.ticker),
            ]);
            try {
                return enrichPosition(pos, openBuys, plan, t);
            } catch {
                // A stale plan in a different currency than the position — degrade that row
                // (no R/stop math) rather than failing the whole panel.
                return enrichPosition(pos, openBuys, null, t);
            }
        }));
        return c.json({ positions: rows });
    });

    return r;
}
