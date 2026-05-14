import { Hono } from 'hono';
import { requireAuth, requireRole } from '@trader/shared-auth/middleware';
import type { ApproveSignalUseCase } from '../../application/use-cases/ApproveSignal.ts';
import type { GetSignalProgressUseCase } from '../../application/use-cases/GetSignalProgress.ts';

interface Deps {
  findRecent: { execute: (limit: number) => Promise<unknown[]> };
  approveSignal: ApproveSignalUseCase;
  getProgress: GetSignalProgressUseCase;
}

export function createRouter(deps: Deps): Hono {
  const router = new Hono();

  // Path-scoped, not wildcard. A wildcard `use('*', mw)` on a subapp mounted via
  // `app.route('/', subapp)` bleeds onto every route on the parent app — including the
  // /internal/* routes registered later via createInternalRouter, which then fail their
  // own X-Internal-Token gate because the JWT requirement runs first. See PROGRESS.md.
  router.use('/api/*', requireAuth);

  router.get('/api/signals', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200);
    const signals = await deps.findRecent.execute(limit);
    return c.json({ signals });
  });

  // Enriched view: signal + live price + portfolio weight + age + P&L. The portal's
  // Signal Feed reads this so the UI only makes one fetch per refresh.
  router.get('/api/signals/progress', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200);
    const signals = await deps.getProgress.execute(limit);
    return c.json({ signals });
  });

  // Admin approve: flips lifecycle to 'approved' and triggers trading-service auto-execute
  // (which itself decides whether to place the order based on TRADING_MODE).
  router.post('/api/admin/signals/approve/:id', requireRole('admin'), async (c) => {
    const id = c.req.param('id');
    await deps.approveSignal.execute(id);
    return c.json({ approved: id });
  });

  return router;
}
