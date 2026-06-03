import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { parseUserHeaders, parseAdminHeaders } from '@trader/shared-auth/middleware';
import { Signals as SignalsContracts } from '@trader/contracts';
import type { ApproveSignalUseCase } from '../../approval/application/ApproveSignal.ts';
import type { GetSignalProgressUseCase } from '../application/GetSignalProgress.ts';
import type { AutoApprovalGate } from '../../approval/application/AutoApprovalGate.ts';
import type { ISignalRepository } from '../domain/ISignalRepository.ts';
import type { RiskEngine } from '../../risk/application/RiskEngine.ts';
import type { TripRecorder } from '../../risk/application/TripRecorder.ts';
import { SignalLifecycle, SignalFailureReason } from '@trader/shared-types';

interface Deps {
  findRecent: { execute: (limit: number) => Promise<unknown[]> };
  approveSignal: ApproveSignalUseCase;
  getProgress: GetSignalProgressUseCase;
  autoApprovalGate: AutoApprovalGate;
  signalRepo: ISignalRepository;
  riskEngine: RiskEngine;
  tripRecorder: TripRecorder;
}

/**
 * /api/signals/* (user) and /admin/api/signals/* (admin) — the portal-facing routes.
 * Each service is its own auth perimeter: the path prefix encodes the audience, and the
 * matching parser is mounted per scope.
 */
export function createRouter(deps: Deps): Hono {
  const router = new Hono();

  // Path-scoped (NOT a wildcard) so the parsers don't bleed onto /internal/api/* mounted
  // later on the same Hono app. See the comment in createInternalRouter for the regression
  // this avoids.
  router.use('/api/signals/*',       parseUserHeaders);
  router.use('/admin/api/signals/*', parseAdminHeaders);

  // ── User-scope reads ──────────────────────────────────────────────────────
  router.get('/api/signals/recent', async (c) => {
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

  // ── Admin: signals lifecycle control ──────────────────────────────────────
  router.get('/admin/api/signals/history', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200);
    const signals = await deps.findRecent.execute(limit);
    return c.json({ signals });
  });

  // Admin approve: flips lifecycle to 'approved' and triggers trading-service auto-execute
  // (which itself decides whether to place the order based on TRADING_MODE).
  router.post('/admin/api/signals/approve/:id', async (c) => {
    const id = c.req.param('id')!;
    await deps.approveSignal.execute(id);
    return c.json({ approved: id });
  });

  // Auto-approve: when enabled, every freshly generated signal is approved on emission.
  // BUYs are pro-rated to fit free cash so the optimiser's ratio + sector cap survive.
  // Fires real T212 orders in demo/live mode — operator opts in deliberately.
  router.get('/admin/api/signals/auto-approve', async (c) => {
    return c.json({ enabled: await deps.autoApprovalGate.isEnabled() });
  });
  router.post(
    '/admin/api/signals/auto-approve',
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
  router.post('/admin/api/signals/retry/:id', async (c) => {
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
  router.post('/admin/api/signals/cancel/:id', async (c) => {
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

  // Risk engine status — circuit-breaker state, NAV snapshot, current drawdown.
  router.get('/admin/api/signals/risk/status', async (c) => {
    const status = await deps.riskEngine.status();
    return c.json(status);
  });

  // Reset the circuit breaker manually (after investigating the trip cause).
  router.post('/admin/api/signals/risk/circuit-breaker/reset', async (c) => {
    await deps.riskEngine.resetCircuitBreaker();
    return c.json({ reset: true, ts: Date.now() });
  });

  // Operator controls — kill switch (halts new emission AND the dispatcher drain) + pause
  // (halts emission only; the dispatcher keeps draining in-flight orders). Distinct from the
  // automatic NAV circuit breaker.
  router.get('/admin/api/signals/risk/controls', async (c) => {
    return c.json(await deps.riskEngine.operatorState());
  });
  router.post('/admin/api/signals/risk/kill-switch', async (c) => {
    const { on } = await c.req.json().catch(() => ({ on: undefined }));
    if (typeof on !== 'boolean') return c.json({ error: 'body { on: boolean } required' }, 400);
    await deps.riskEngine.setKillSwitch(on);
    return c.json({ killSwitch: on, ts: Date.now() });
  });
  router.post('/admin/api/signals/strategy/pause', async (c) => {
    const { on } = await c.req.json().catch(() => ({ on: undefined }));
    if (typeof on !== 'boolean') return c.json({ error: 'body { on: boolean } required' }, 400);
    await deps.riskEngine.setPaused(on);
    return c.json({ paused: on, ts: Date.now() });
  });

  // Post-mortem list — one row per historical trip. Lean projection (no positions,
  // no signals array) so the portal table renders fast. Detail view fetches the
  // full doc separately.
  router.get('/admin/api/signals/risk/trips', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200);
    const trips = await deps.tripRecorder.list(limit);
    return c.json({ trips });
  });

  // Full post-mortem for a single trip — risk numbers, cash/positions snapshot,
  // last-50 signals at the moment of trip, recent rejections, and the BUY ids the
  // auto-drain cancelled.
  router.get('/admin/api/signals/risk/trips/:id', async (c) => {
    const trip = await deps.tripRecorder.findById(c.req.param('id')!);
    if (!trip) return c.json({ error: 'not found' }, 404);
    return c.json(trip);
  });

  return router;
}
