import { Hono } from 'hono';
import { requireAuth, requireRole } from '@trader/shared-auth/middleware';
import type { ApproveSignalUseCase } from '../../application/use-cases/ApproveSignal.ts';
import type { GetSignalProgressUseCase } from '../../application/use-cases/GetSignalProgress.ts';
import type { AutoApprovalGate } from '../../application/services/AutoApprovalGate.ts';
import type { ISignalRepository } from '../../domain/interfaces/ISignalRepository.ts';
import { SignalLifecycle, SignalFailureReason } from '@trader/shared-types';

interface Deps {
  findRecent: { execute: (limit: number) => Promise<unknown[]> };
  approveSignal: ApproveSignalUseCase;
  getProgress: GetSignalProgressUseCase;
  autoApprovalGate: AutoApprovalGate;
  signalRepo: ISignalRepository;
}

export function createRouter(deps: Deps): Hono {
  const router = new Hono();

  // Path-scoped, not wildcard. A wildcard `use('*', mw)` on a subapp mounted via
  // `app.route('/', subapp)` bleeds onto every route on the parent app — including the
  // /internal/* routes registered later via createInternalRouter, which then fail their
  // own internal-auth gate because the JWT requirement runs first. See PROGRESS.md.
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
    const id = c.req.param('id')!;
    await deps.approveSignal.execute(id);
    return c.json({ approved: id });
  });

  // Auto-approve: when enabled, every freshly generated signal is approved on emission.
  // BUYs are pro-rated to fit free cash so the optimiser's ratio + sector cap survive.
  // Fires real T212 orders in demo/live mode — operator opts in deliberately.
  router.get('/api/admin/signals/auto-approve', requireRole('admin'), async (c) => {
    return c.json({ enabled: await deps.autoApprovalGate.isEnabled() });
  });
  router.post('/api/admin/signals/auto-approve', requireRole('admin'), async (c) => {
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({} as { enabled?: boolean }));
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) required' }, 400);
    await deps.autoApprovalGate.setEnabled(body.enabled);
    return c.json({ enabled: body.enabled });
  });

  // Retry a failed signal: failed → queued, attempts reset. The dispatcher picks it up on
  // its next claim. Conditions (drift, cash, TTL) are re-evaluated then — a retry doesn't
  // guarantee execution, only another attempt.
  router.post('/api/admin/signals/retry/:id', requireRole('admin'), async (c) => {
    const id = c.req.param('id')!;
    const signal = await deps.signalRepo.findById(id);
    if (!signal) return c.json({ error: 'not found' }, 404);
    if (signal.lifecycle !== SignalLifecycle.Failed) {
      return c.json({ error: `cannot retry signal in lifecycle=${SignalLifecycle[signal.lifecycle]}` }, 400);
    }
    await deps.signalRepo.retry(id);
    return c.json({ id, lifecycle: SignalLifecycle.Queued, attempts: 0 });
  });

  // Cancel a queued / executing signal: transitions to Failed/ManualCancel. The strategy
  // treats it as if it never happened (no entry in the FIFO BUY ledger).
  router.post('/api/admin/signals/cancel/:id', requireRole('admin'), async (c) => {
    const id = c.req.param('id')!;
    const signal = await deps.signalRepo.findById(id);
    if (!signal) return c.json({ error: 'not found' }, 404);
    if (signal.lifecycle !== SignalLifecycle.Queued
      && signal.lifecycle !== SignalLifecycle.Executing
      && signal.lifecycle !== SignalLifecycle.Approved) {
      return c.json({ error: `cannot cancel signal in lifecycle=${SignalLifecycle[signal.lifecycle]}` }, 400);
    }
    await deps.signalRepo.markFailed(id, SignalFailureReason.ManualCancel, 'cancelled by admin from portal');
    return c.json({ id, lifecycle: SignalLifecycle.Failed, reason: SignalFailureReason.ManualCancel });
  });

  return router;
}
