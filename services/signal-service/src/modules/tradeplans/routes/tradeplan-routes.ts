// Trade-plan CRUD + enriched-positions read (portal-facing, admin-gated). The portal
// /positions panel reads positions/enriched; the editor PUT/DELETEs per-ticker plans.

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { parseAdminHeaders } from '@trader/shared-auth/middleware';
import { Trading, type Position } from '@trader/contracts';
import type { ITradePlanRepository } from '../domain/TradePlan.ts';
import type { ISignalRepository } from '../../signals/domain/ISignalRepository.ts';
import type { IAlertRuleRepository } from '../../alerts/domain/AlertRule.ts';
import { enrichAll } from '../application/EnrichedPositions.ts';
import { deriveRulesFromPlan } from '../../alerts/application/detect.ts';

export interface TradePlanRouterDeps {
    tradePlanRepo: ITradePlanRepository;
    signalRepo: ISignalRepository;
    // Positions come from the synced Mongo `positions` collection (what signal-service already
    // reads for NAV) — NOT trading-service's internal endpoint, which only authorizes
    // portfolio-service as a caller (a signal-service call gets 403).
    listPositions: () => Promise<Position[]>;
    // When present, saving a plan auto-derives stop/target price-alert rules (visible on /alerts).
    alertRules?: IAlertRuleRepository | undefined;
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
            // Auto-derive stop/target price-alert rules from the saved plan (deterministic ids, so
            // re-saving updates rather than duplicates; cleared fields remove their derived rule).
            if (deps.alertRules) {
                const { upsert, removeIds } = deriveRulesFromPlan({ ticker, stop: plan.stop, target: plan.target });
                await Promise.all([
                    ...upsert.map((dr) => deps.alertRules!.upsert(dr)),
                    ...removeIds.map((id) => deps.alertRules!.remove(id)),
                ]);
            }
            return c.json(plan);
        },
    );

    r.delete('/admin/api/signals/trade-plans/:ticker', parseAdminHeaders, async (c) => {
        const ticker = c.req.param('ticker');
        if (!ticker) return c.json({ error: 'missing ticker' }, 400);
        const removed = await deps.tradePlanRepo.remove(ticker);
        return c.json({ removed });
    });

    // Positions (from the synced Mongo collection) joined with entry/days-held + trade plan +
    // derived R-multiple/stop distance. A read-only panel must never hard-500 because the source
    // is momentarily unavailable, so a fetch failure degrades to an empty list.
    r.get('/admin/api/signals/positions/enriched', parseAdminHeaders, async (c) => {
        let positions: Position[];
        try {
            positions = await deps.listPositions();
        } catch {
            return c.json({ positions: [], error: 'positions temporarily unavailable' });
        }
        const rows = await enrichAll(
            positions,
            (ticker) => deps.signalRepo.findOpenBuysByTicker(ticker),
            (ticker) => deps.tradePlanRepo.get(ticker),
            now(),
        );
        return c.json({ positions: rows });
    });

    return r;
}
