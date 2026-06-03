// Pie read routes (portal-facing, admin-gated) — the Scanner/dashboard pie views read these.
// Execution + sync are internal; these are pure reads. Per-route parseAdminHeaders (user JWT).

import { Hono } from 'hono';
import { parseAdminHeaders } from '@trader/shared-auth/middleware';
import type { IPieRepository } from '../domain/Pie.ts';

export function createPieRouter(pieRepo: IPieRepository): Hono {
  const r = new Hono();

  r.get('/admin/api/signals/pies', parseAdminHeaders, async (c) =>
    c.json({ pies: await pieRepo.listAll() }));

  r.get('/admin/api/signals/pies/strategy/:strategyId', parseAdminHeaders, async (c) => {
    const strategyId = c.req.param('strategyId');
    if (!strategyId) return c.json({ error: 'missing strategyId' }, 400);
    const pie = await pieRepo.findActiveByStrategy(strategyId);
    return pie ? c.json(pie) : c.json({ error: 'no active pie for strategy' }, 404);
  });

  r.get('/admin/api/signals/pies/:id', parseAdminHeaders, async (c) => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'missing pie id' }, 400);
    const pie = await pieRepo.findById(id);
    return pie ? c.json(pie) : c.json({ error: 'pie not found' }, 404);
  });

  return r;
}
