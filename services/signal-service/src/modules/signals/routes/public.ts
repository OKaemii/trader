import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireInternal, requireCaller } from '@trader/shared-auth/middleware';
import { Signals as SignalsContracts } from '@trader/contracts';
import type { ApproveSignalUseCase } from '../../approval/application/ApproveSignal.ts';
import type { GetSignalProgressUseCase } from '../application/GetSignalProgress.ts';
import type { AutoApprovalGate } from '../../approval/application/AutoApprovalGate.ts';
import type { ISignalRepository } from '../domain/ISignalRepository.ts';
import type { RiskEngine } from '../../risk/application/RiskEngine.ts';
import { SignalLifecycle, SignalFailureReason } from '@trader/shared-types';

interface Deps {
  findRecent: { execute: (limit: number) => Promise<unknown[]> };
  approveSignal: ApproveSignalUseCase;
  getProgress: GetSignalProgressUseCase;
  autoApprovalGate: AutoApprovalGate;
  signalRepo: ISignalRepository;
  riskEngine: RiskEngine;
}

export function createRouter(deps: Deps): Hono {
  const router = new Hono();

  // Gateway is the user-auth perimeter. All `/api/*` traffic arrives here only via the
  // gateway proxy, which mints a fresh internal JWT (sub='api-gateway') per request.
  // Path-scoped guard so this doesn't bleed onto the /internal/* peer routes mounted
  // by createInternalRouter (which pin a different requireCaller).
  router.use('/api/*', requireInternal, requireCaller('api-gateway'));

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
  // (which itself decides whether to place the order based on TRADING_MODE). The gateway
  // has already verified the caller is an admin user — `/api/admin/*` here is just a
  // logical namespace; per-route role re-checks would be redundant.
  router.post('/api/admin/signals/approve/:id', async (c) => {
    const id = c.req.param('id')!;
    await deps.approveSignal.execute(id);
    return c.json({ approved: id });
  });

  // Auto-approve: when enabled, every freshly generated signal is approved on emission.
  // BUYs are pro-rated to fit free cash so the optimiser's ratio + sector cap survive.
  // Fires real T212 orders in demo/live mode — operator opts in deliberately.
  router.get('/api/admin/signals/auto-approve', async (c) => {
    return c.json({ enabled: await deps.autoApprovalGate.isEnabled() });
  });
  router.post(
    '/api/admin/signals/auto-approve',
    zValidator('json', SignalsContracts.AutoApproveBodySchema, (result, c) => {
      if (!result.success) return c.json({ error: 'enabled (boolean) required' }, 400);
    }),
    async (c) => {
      const { enabled } = c.req.valid('json');
      await deps.autoApprovalGate.setEnabled(enabled);
      return c.json({ enabled });
    },
  );

  // Retry a failed signal: failed → queued, attempts reset. The dispatcher picks it up on
  // its next claim. Conditions (drift, cash, TTL) are re-evaluated then — a retry doesn't
  // guarantee execution, only another attempt.
  router.post('/api/admin/signals/retry/:id', async (c) => {
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
  router.post('/api/admin/signals/cancel/:id', async (c) => {
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

  // History — most-recent signals (admin's primary feed view on the portal).
  router.get('/api/admin/signals/history', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200);
    const signals = await deps.findRecent.execute(limit);
    return c.json({ signals });
  });

  // Risk engine status — circuit-breaker state, NAV snapshot, current drawdown.
  router.get('/api/admin/risk/status', async (c) => {
    const status = await deps.riskEngine.status();
    return c.json(status);
  });

  // Reset the circuit breaker manually (after investigating the trip cause).
  router.post('/api/admin/risk/circuit-breaker/reset', async (c) => {
    await deps.riskEngine.resetCircuitBreaker();
    return c.json({ reset: true, ts: Date.now() });
  });

  return router;
}
