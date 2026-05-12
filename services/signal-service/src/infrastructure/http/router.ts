import { Hono } from 'hono';
import { requireAuth } from '@trader/shared-auth/middleware';
import type { ApproveSignalUseCase } from '../../application/use-cases/ApproveSignal.ts';
import type { GetSignalProgressUseCase } from '../../application/use-cases/GetSignalProgress.ts';

interface Deps {
  findRecent: { execute: (limit: number) => Promise<unknown[]> };
  approveSignal: ApproveSignalUseCase;
  getProgress: GetSignalProgressUseCase;
}

export function createRouter(deps: Deps): Hono {
  const router = new Hono();

  router.use('*', requireAuth);

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

  return router;
}
