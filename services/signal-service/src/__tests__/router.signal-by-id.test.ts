// Route-level tests for GET /admin/api/signals/:id — backs the portal /signals/[id]
// detail page and the notification-email deep link. The contracts worth pinning:
//   - admin auth gate (parseAdminHeaders) — an end-user/anon caller never reaches it,
//   - it reads THIS service's own repo (signalRepo.findById) — no cross-service hop,
//   - 200 + the full signal doc when found, 404 { error: 'not found' } when absent,
//   - the literal /admin/api/signals/* routes (e.g. /history) still win over the
//     `:id` param (so adding the catch-all didn't shadow the existing endpoints).

process.env.INTERNAL_SECRET = 'test-internal-secret';
process.env.JWT_SECRET      = 'test-jwt-secret';

import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { signAccessToken } from '@trader/shared-auth';
import { createRouter } from '../modules/signals/routes/public.ts';
import type { ISignalRepository } from '../modules/signals/domain/ISignalRepository.ts';
import { TradeSignal, SignalLifecycle, SignalFailureReason } from '../modules/signals/domain/TradeSignal.ts';

let adminJWT: string;
beforeAll(async () => {
  adminJWT = await signAccessToken({ sub: 'tester', role: 'admin' });
});

function adminHeaders() {
  return { Authorization: `Bearer ${adminJWT}` };
}

class StubRepo implements ISignalRepository {
  constructor(private fixture: TradeSignal | null, private byTicker: TradeSignal[] = []) {}

  async save() {}
  async findById(id: string) { return this.fixture && this.fixture.id === id ? this.fixture : null; }
  async findRecent() { return []; }
  async approve() {}
  async markExecuted() {}
  async markClosed() {}
  async findOpenBuysByTicker() { return []; }
  async decrementExecutedQuantity() {}
  async setTargetWeight() {}
  async markQueued() {}
  async claimNextQueued() { return null; }
  async requeue() {}
  async markFailed() {}
  async retry() {}
  async sweepStaleExecuting() { return 0; }
  async findByLifecycle() { return []; }
  async findByTicker(ticker: string) { return this.byTicker.filter((s) => s.ticker === ticker); }
  async bulkCancelOpenBuys() { return []; }
}

function signal(id: string): TradeSignal {
  return new TradeSignal({
    id, timestamp: 1_700_000_000_000, ticker: 'AAPL_US_EQ', strategy_id: 'factor_rank_v1',
    action: 'BUY', confidence: 0.42, targetWeight: 0.05,
    rationale: JSON.stringify({ plain_english: 'momentum + low vol', uncertainty: 'low' }),
    lifecycle: SignalLifecycle.Executed, entryPrice: 187.5, executedQuantity: 3,
  });
}

function buildApp(repo: StubRepo) {
  const app = new Hono();
  app.route('/', createRouter({
    findRecent:    { execute: async () => [{ id: 'recent-1' }] },
    approveSignal: { execute: async () => {} } as any,
    getProgress:   { execute: async () => [] } as any,
    autoApprovalGate: {} as any,
    signalRepo: repo,
    riskEngine:    { status: async () => ({}), resetCircuitBreaker: async () => {} } as any,
    tripRecorder:  { list: async () => [], findById: async () => null } as any,
  }));
  return app;
}

describe('GET /admin/api/signals/:id', () => {
  it('401s without an admin token', async () => {
    const app = buildApp(new StubRepo(signal('s1')));
    const res = await app.request('/admin/api/signals/s1');
    expect(res.status).toBe(401);
  });

  it('404s with { error: "not found" } when the signal does not exist', async () => {
    const repo = new StubRepo(null);
    const res  = await buildApp(repo).request('/admin/api/signals/missing', { headers: adminHeaders() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('returns 200 + the signal doc when found', async () => {
    const repo = new StubRepo(signal('s1'));
    const res  = await buildApp(repo).request('/admin/api/signals/s1', { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: 's1',
      ticker: 'AAPL_US_EQ',
      action: 'BUY',
      strategy_id: 'factor_rank_v1',
      lifecycle: SignalLifecycle.Executed,
      entryPrice: 187.5,
      executedQuantity: 3,
    });
    // rationale survives as the raw JSON string the portal parses client-side.
    expect(typeof body.rationale).toBe('string');
    expect(JSON.parse(body.rationale).plain_english).toBe('momentum + low vol');
  });

  it('does not shadow the literal /admin/api/signals/history route', async () => {
    // The catch-all :id is registered last; the static `history` segment must still win.
    const repo = new StubRepo(null);
    const res  = await buildApp(repo).request('/admin/api/signals/history', { headers: adminHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signals: [{ id: 'recent-1' }] });
  });

  it('exposes SignalFailureReason on a failed signal', async () => {
    const failed = new TradeSignal({
      id: 'f1', timestamp: 1_700_000_000_000, ticker: 'BP_l_EQ', strategy_id: 'factor_rank_v1',
      action: 'BUY', confidence: 0.3, targetWeight: 0.02, rationale: '{}',
      lifecycle: SignalLifecycle.Failed, failureReason: SignalFailureReason.MarketDrift,
      failureDetail: 'price moved 1.4% since emission',
    });
    const res = await buildApp(new StubRepo(failed)).request('/admin/api/signals/f1', { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failureReason).toBe(SignalFailureReason.MarketDrift);
    expect(body.failureDetail).toBe('price moved 1.4% since emission');
  });
});

describe('GET /admin/api/signals/by-ticker/:ticker', () => {
  function buy(id: string, ticker: string, lifecycle: SignalLifecycle): TradeSignal {
    return new TradeSignal({
      id, timestamp: 1_700_000_000_000, ticker, strategy_id: 'factor_rank_v1',
      action: 'BUY', confidence: 0.4, targetWeight: 0.05, rationale: '{}', lifecycle,
    });
  }

  it('401s without an admin token', async () => {
    const app = buildApp(new StubRepo(null, [buy('s1', 'AAPL_US_EQ', SignalLifecycle.Executed)]));
    const res = await app.request('/admin/api/signals/by-ticker/AAPL_US_EQ');
    expect(res.status).toBe(401);
  });

  it('returns { ticker, signals } scoped to that symbol, including failed/cancelled rows', async () => {
    // The per-symbol tab is an audit trail — a failed signal still belongs (unlike the
    // tradeable-feed consumers that filter to {executed, closed}).
    const fixtures = [
      buy('a1', 'AAPL_US_EQ', SignalLifecycle.Executed),
      buy('a2', 'AAPL_US_EQ', SignalLifecycle.Failed),
      buy('b1', 'BP_l_EQ', SignalLifecycle.Executed),
    ];
    const res = await buildApp(new StubRepo(null, fixtures))
      .request('/admin/api/signals/by-ticker/AAPL_US_EQ', { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticker).toBe('AAPL_US_EQ');
    expect(body.signals.map((s: { id: string }) => s.id)).toEqual(['a1', 'a2']);
    expect(body.signals.some((s: { lifecycle: number }) => s.lifecycle === SignalLifecycle.Failed)).toBe(true);
  });

  it('returns an empty list (200) for a symbol with no signals', async () => {
    const res = await buildApp(new StubRepo(null, []))
      .request('/admin/api/signals/by-ticker/TSLA_US_EQ', { headers: adminHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticker: 'TSLA_US_EQ', signals: [] });
  });

  it('does not get shadowed by the :id catch-all (static by-ticker segment wins)', async () => {
    // If `:id` had priority, this would 404 (no signal with id "by-ticker"); instead the
    // static by-ticker route claims it and returns the (empty) per-symbol list.
    const res = await buildApp(new StubRepo(null, []))
      .request('/admin/api/signals/by-ticker/MSFT_US_EQ', { headers: adminHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticker: 'MSFT_US_EQ', signals: [] });
  });
});
