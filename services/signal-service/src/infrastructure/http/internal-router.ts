import { Hono } from 'hono';
import { requireInternalToken } from '@trader/shared-auth/middleware';
import type { ApproveSignalUseCase } from '../../application/use-cases/ApproveSignal.ts';
import type { RiskEngine } from '../../application/services/RiskEngine.ts';
import type { ISignalRepository } from '../../domain/interfaces/ISignalRepository.ts';
import type { ISignalPublisher } from '../../domain/interfaces/ISignalPublisher.ts';

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
    requireInternalToken('trading-service'),
    async (c) => {
      const id = c.req.param('id');
      const body = await c.req.json<{ at?: number; quantity?: number }>().catch(() => ({}));
      const at = typeof body.at === 'number' ? body.at : Date.now();
      // `quantity` is the actual filled share count (sent from FillsPoller). Optional so
      // older callers (PlaceOrderUseCase notify-on-submit) keep working — they don't know
      // the fill quantity yet and pass undefined.
      await deps.signalRepo.markExecuted(id, at, body.quantity);
      // Publish to TRADE_SIGNALS only on executed — this is the email trigger. The signal
      // is reloaded so the published payload reflects the post-update state (lifecycle,
      // executedAt, etc) rather than the wire-input.
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
    requireInternalToken('trading-service'),
    async (c) => {
      const id = c.req.param('id');
      const body = await c.req.json<{ at?: number; exitPrice: number }>();
      const at = typeof body.at === 'number' ? body.at : Date.now();
      await deps.signalRepo.markClosed(id, at, body.exitPrice);
      return c.json({ id, closedAt: at, exitPrice: body.exitPrice });
    },
  );

  // Round-trip closure helper: list executed BUYs for a ticker, oldest-first. Used by
  // FillsPoller to FIFO-attribute SELL fills back to entry signals.
  router.get(
    '/internal/trading/signals/open-buys/:ticker',
    requireInternalToken('trading-service'),
    async (c) => {
      const ticker = c.req.param('ticker');
      const signals = await deps.signalRepo.findOpenBuysByTicker(ticker);
      return c.json({ signals });
    },
  );

  // Decrement an executed BUY's remaining share count without closing it (partial SELL
  // consumption). Caller sends the amount to subtract; signal-service clamps at 0.
  router.post(
    '/internal/trading/signals/:id/decrement-quantity',
    requireInternalToken('trading-service'),
    async (c) => {
      const id = c.req.param('id');
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
    requireInternalToken('trading-service'),
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
    requireInternalToken('trading-service'),
    async (c) => {
      const id = c.req.param('id');
      await deps.signalRepo.requeue(id);
      return c.json({ id, lifecycle: 'queued' });
    },
  );

  router.post(
    '/internal/queue/:id/failed',
    requireInternalToken('trading-service'),
    async (c) => {
      const id = c.req.param('id');
      const body = await c.req.json<{ reason: string; detail?: string }>();
      // Cast — the type narrowing happens at the repository level since the union is
      // defined in shared-types and the body is unvalidated wire data.
      await deps.signalRepo.markFailed(id, body.reason as any, body.detail);
      return c.json({ id, lifecycle: 'failed', reason: body.reason });
    },
  );

  router.post(
    '/internal/queue/sweep',
    requireInternalToken('trading-service'),
    async (c) => {
      const body = await c.req.json<{ thresholdMs?: number }>().catch(() => ({}));
      const ms   = typeof body.thresholdMs === 'number' ? body.thresholdMs : 60_000;
      const reverted = await deps.signalRepo.sweepStaleExecuting(ms);
      return c.json({ reverted });
    },
  );

  // api-gateway-scoped routes. Per-route middleware (NOT a wildcard `use('/internal/*', mw)`)
  // because Hono applies wildcard middleware to routes registered before it on the same
  // router, which previously double-gated the trading-service callbacks above and made them
  // 401 with the wrong caller — see PROGRESS.md for the regression.
  const requireGateway = requireInternalToken('api-gateway');

  router.get('/internal/signals/latest', requireGateway, async (c) => {
    const signals = await deps.findRecent.execute(50);
    return c.json({ signals });
  });

  router.post('/internal/signals/approve/:id', requireGateway, async (c) => {
    const id = c.req.param('id');
    await deps.approveSignal.execute(id);
    return c.json({ approved: id });
  });

  router.get('/internal/risk/status', requireGateway, async (c) => {
    const status = await deps.riskEngine.status();
    return c.json(status);
  });

  router.post('/internal/risk/circuit-breaker/reset', requireGateway, async (c) => {
    await deps.riskEngine.resetCircuitBreaker();
    return c.json({ reset: true, ts: Date.now() });
  });

  return router;
}
