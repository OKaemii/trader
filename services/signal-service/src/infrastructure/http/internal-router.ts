import { Hono } from 'hono';
import { requireInternalToken } from '@trader/shared-auth/middleware';
import type { ApproveSignalUseCase } from '../../application/use-cases/ApproveSignal.ts';
import type { RiskEngine } from '../../application/services/RiskEngine.ts';

interface Deps {
  findRecent: { execute: (limit: number) => Promise<unknown[]> };
  approveSignal: ApproveSignalUseCase;
  riskEngine: RiskEngine;
}

export function createInternalRouter(deps: Deps): Hono {
  const router = new Hono();

  router.use('/internal/*', requireInternalToken('api-gateway'));

  router.get('/internal/signals/latest', async (c) => {
    const signals = await deps.findRecent.execute(50);
    return c.json({ signals });
  });

  router.post('/internal/signals/approve/:id', async (c) => {
    const id = c.req.param('id');
    await deps.approveSignal.execute(id);
    return c.json({ approved: id });
  });

  router.get('/internal/risk/status', async (c) => {
    const status = await deps.riskEngine.status();
    return c.json(status);
  });

  router.post('/internal/risk/circuit-breaker/reset', async (c) => {
    await deps.riskEngine.resetCircuitBreaker();
    return c.json({ reset: true, ts: Date.now() });
  });

  return router;
}
