import { Hono } from 'hono';
import { requireInternal, requireCaller } from '@trader/shared-auth/middleware';
import type { ApproveSignalUseCase } from '../../application/use-cases/ApproveSignal.ts';
import type { RiskEngine } from '../../application/services/RiskEngine.ts';
import type { ISignalRepository } from '../../domain/interfaces/ISignalRepository.ts';
import type { ISignalPublisher } from '../../domain/interfaces/ISignalPublisher.ts';
import { SignalLifecycle, SignalFailureReason } from '@trader/shared-types';

interface Deps {
  findRecent: { execute: (limit: number) => Promise<unknown[]> };
  approveSignal: ApproveSignalUseCase;
  riskEngine: RiskEngine;
  signalRepo: ISignalRepository;
  // Publisher gated on the executed transition so notification-service only emails
  // signals that actually went through to T212 (policy b — see CLAUDE.md).
  publisher: ISignalPublisher;
}

export function createInternalRouter(deps: Deps): Hono {
  const router = new Hono();

  // Trading-service lifecycle callbacks live under /internal/trading/* with a separate
  // caller check. Registered before the api-gateway-scoped middleware so route lookup
  // matches here first.
  router.post(
    '/internal/trading/signals/:id/executed',
    requireInternal, requireCaller('trading-service'),
    async (c) => {
      const id = c.req.param('id')!;
      const body = await c.req.json<{ at?: number; quantity?: number }>().catch(() => ({} as { at?: number; quantity?: number }));
      const at = typeof body.at === 'number' ? body.at : Date.now();
      await deps.signalRepo.markExecuted(id, at, body.quantity);
      const signal = await deps.signalRepo.findById(id);
      if (signal) {
        try { await deps.publisher.publish(signal); }
        catch (e) { console.warn(`[internal] publish on executed failed for ${id}:`, e); }
      }
      return c.json({ id, executedAt: at, executedQuantity: body.quantity });
    },
  );

  router.post(
    '/internal/trading/signals/:id/closed',
    requireInternal, requireCaller('trading-service'),
    async (c) => {
      const id = c.req.param('id')!;
      const body = await c.req.json<{ at?: number; exitPrice: number }>();
      const at = typeof body.at === 'number' ? body.at : Date.now();
      await deps.signalRepo.markClosed(id, at, body.exitPrice);
      return c.json({ id, closedAt: at, exitPrice: body.exitPrice });
    },
  );

  router.get(
    '/internal/trading/signals/open-buys/:ticker',
    requireInternal, requireCaller('trading-service'),
    async (c) => {
      const ticker = c.req.param('ticker')!;
      const signals = await deps.signalRepo.findOpenBuysByTicker(ticker);
      return c.json({ signals });
    },
  );

  router.post(
    '/internal/trading/signals/:id/decrement-quantity',
    requireInternal, requireCaller('trading-service'),
    async (c) => {
      const id = c.req.param('id')!;
      const body = await c.req.json<{ by: number }>();
      await deps.signalRepo.decrementExecutedQuantity(id, body.by);
      return c.json({ id, decrementedBy: body.by });
    },
  );

  // ---------- Order-dispatcher queue endpoints (called by trading-service) ----------
  //
  // The signal collection IS the durable queue. claim returns the next queued signal
  // atomically (no double-execution under multi-pod dispatcher). requeue/failed close
  // the loop after the dispatcher tries to place the order.

  router.post(
    '/internal/queue/claim',
    requireInternal, requireCaller('trading-service'),
    async (c) => {
      const signal = await deps.signalRepo.claimNextQueued();
      if (!signal) return c.json({ signal: null }, 200);
      return c.json({
        signal: {
          id:           signal.id,
          ticker:       signal.ticker,
          action:       signal.action,
          targetWeight: signal.targetWeight,
          confidence:   signal.confidence,
          entryPrice:   signal.entryPrice,
          timestamp:    signal.timestamp,
          attempts:     signal.attempts,
        },
      });
    },
  );

  router.post(
    '/internal/queue/:id/requeue',
    requireInternal, requireCaller('trading-service'),
    async (c) => {
      const id = c.req.param('id')!;
      await deps.signalRepo.requeue(id);
      return c.json({ id, lifecycle: SignalLifecycle.Queued });
    },
  );

  router.post(
    '/internal/queue/:id/failed',
    requireInternal, requireCaller('trading-service'),
    async (c) => {
      const id = c.req.param('id')!;
      const body = await c.req.json<{ reason: number; detail?: string }>();
      const reason = body.reason;
      if (typeof reason !== 'number' || SignalFailureReason[reason] === undefined) {
        return c.json({ error: `invalid reason (expected SignalFailureReason enum integer)` }, 400);
      }
      await deps.signalRepo.markFailed(id, reason, body.detail);
      return c.json({ id, lifecycle: SignalLifecycle.Failed, reason });
    },
  );

  router.post(
    '/internal/queue/sweep',
    requireInternal, requireCaller('trading-service'),
    async (c) => {
      const body = await c.req.json<{ thresholdMs?: number }>().catch(() => ({} as { thresholdMs?: number }));
      const ms   = typeof body.thresholdMs === 'number' ? body.thresholdMs : 60_000;
      const reverted = await deps.signalRepo.sweepStaleExecuting(ms);
      return c.json({ reverted });
    },
  );

  // api-gateway-scoped routes. Per-route middleware (NOT a wildcard `use('/internal/*', mw)`)
  // because Hono applies wildcard middleware to routes registered before it on the same
  // router, which previously double-gated the trading-service callbacks above and made them
  // 401 with the wrong caller — see PROGRESS.md for the regression.
  const requireGateway = requireCaller('api-gateway');

  router.get('/internal/signals/latest', requireInternal, requireGateway, async (c) => {
    const signals = await deps.findRecent.execute(50);
    return c.json({ signals });
  });

  router.post('/internal/signals/approve/:id', requireInternal, requireGateway, async (c) => {
    const id = c.req.param('id')!;
    await deps.approveSignal.execute(id);
    return c.json({ approved: id });
  });

  router.get('/internal/risk/status', requireInternal, requireGateway, async (c) => {
    const status = await deps.riskEngine.status();
    return c.json(status);
  });

  router.post('/internal/risk/circuit-breaker/reset', requireInternal, requireGateway, async (c) => {
    await deps.riskEngine.resetCircuitBreaker();
    return c.json({ reset: true, ts: Date.now() });
  });

  return router;
}
