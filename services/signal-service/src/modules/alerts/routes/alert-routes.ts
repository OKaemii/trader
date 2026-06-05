// Price-alert rule CRUD (portal-facing, admin-gated). The /alerts page manages rules + shows the
// recent fire log (rules with lastFiredAt). Manual rules are created here; trade-plan-derived rules
// are upserted by the trade-plan PUT (see tradeplan-routes) and listed here alongside manual ones.

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { parseAdminHeaders } from '@trader/shared-auth/middleware';
import { Signals } from '@trader/contracts';
import type { IAlertRuleRepository } from '../domain/AlertRule.ts';

export function createAlertRouter(repo: IAlertRuleRepository): Hono {
    const r = new Hono();

    r.get('/admin/api/signals/alerts', parseAdminHeaders, async (c) =>
        c.json({ rules: await repo.list() }));

    r.post('/admin/api/signals/alerts', parseAdminHeaders,
        zValidator('json', Signals.AlertRuleRequestSchema), async (c) => {
            const b = c.req.valid('json');
            return c.json(await repo.upsert({ ...b, source: 'manual' }));
        });

    r.put('/admin/api/signals/alerts/:id', parseAdminHeaders,
        zValidator('json', Signals.AlertRuleRequestSchema), async (c) => {
            const id = c.req.param('id');
            if (!id) return c.json({ error: 'missing id' }, 400);
            const b = c.req.valid('json');
            return c.json(await repo.upsert({ id, ...b, source: 'manual' }));
        });

    r.delete('/admin/api/signals/alerts/:id', parseAdminHeaders, async (c) => {
        const id = c.req.param('id');
        if (!id) return c.json({ error: 'missing id' }, 400);
        return c.json({ removed: await repo.remove(id) });
    });

    return r;
}
