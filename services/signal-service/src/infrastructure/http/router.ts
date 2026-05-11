import { Hono } from 'hono';
import { requireAuth } from '@trader/shared-auth/middleware';
import type { ISignalRepository } from '../../domain/interfaces/ISignalRepository.ts';
import type { ApproveSignalUseCase } from '../../application/use-cases/ApproveSignal.ts';

interface Deps {
  findRecent: { execute: (limit: number) => Promise<unknown[]> };
  approveSignal: ApproveSignalUseCase;
}

export function createRouter(deps: Deps): Hono {
  const router = new Hono();

  router.use('*', requireAuth);

  router.get('/api/signals', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200);
    const signals = await deps.findRecent.execute(limit);
    return c.json({ signals });
  });

  return router;
}
