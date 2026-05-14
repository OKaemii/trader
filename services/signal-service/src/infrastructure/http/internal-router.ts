import { Hono } from 'hono';
import { requireInternalToken } from '@trader/shared-auth/middleware';
import type { ApproveSignalUseCase } from '../../application/use-cases/ApproveSignal.ts';
import type { RiskEngine } from '../../application/services/RiskEngine.ts';
import type { ISignalRepository } from '../../domain/interfaces/ISignalRepository.ts';

interface Deps {
  findRecent: { execute: (limit: number) => Promise<unknown[]> };
  approveSignal: ApproveSignalUseCase;
  riskEngine: RiskEngine;
  signalRepo: ISignalRepository;
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
