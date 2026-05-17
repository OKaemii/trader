// Route-level tests for the new admin retry / cancel actions on signal-service.
// These exist for operator workflows in the portal:
//   - retry: move a `failed` signal back to `queued`, reset attempts=0
//   - cancel: move a `queued`/`executing`/`approved` signal to `failed`/`manual_cancel`
//
// Beyond auth, the contract worth pinning is the **lifecycle precondition** — retry
// only works on `failed`, cancel only on the still-actionable states. A stale portal
// must not be able to whiplash a signal that's already executed.

process.env.INTERNAL_SECRET = 'test-internal-secret';
process.env.JWT_SECRET      = 'test-jwt-secret';

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from 'hono';
import { signAccessToken } from '@trader/shared-auth/jwt';
import { createRouter } from '../infrastructure/http/router.ts';
import type { ISignalRepository } from '../domain/interfaces/ISignalRepository.ts';
import { TradeSignal, SignalLifecycle, SignalFailureReason } from '../domain/entities/TradeSignal.ts';

let adminJWT: string;
beforeAll(async () => {
  adminJWT = await signAccessToken({ sub: 'tester', role: 'admin' });
});

function adminHeaders() {
  return { Authorization: `Bearer ${adminJWT}` };
}

class StubRepo implements ISignalRepository {
  public retried: string[] = [];
  public markedFailed: Array<{ id: string; reason: SignalFailureReason; detail?: string }> = [];

  constructor(private fixture: TradeSignal | null) {}

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
  async markFailed(id: string, reason: any, detail?: string) { this.markedFailed.push({ id, reason, detail }); }
  async retry(id: string) { this.retried.push(id); }
  async sweepStaleExecuting() { return 0; }
  async findByLifecycle() { return []; }
}

function signal(id: string, lifecycle: SignalLifecycle): TradeSignal {
  return new TradeSignal({
    id, timestamp: 0, ticker: 'AAPL_US_EQ', strategy_id: 's', action: 'BUY',
    confidence: 0.5, targetWeight: 0.01, rationale: '{}', lifecycle,
  });
}

function buildApp(repo: StubRepo) {
  const app = new Hono();
  app.route('/', createRouter({
    findRecent:    { execute: async () => [] },
    approveSignal: { execute: async () => {} } as any,
    getProgress:   { execute: async () => [] } as any,
    autoApprovalGate: {} as any,
    signalRepo: repo,
  }));
  return app;
}

describe('POST /api/admin/signals/retry/:id', () => {
  it('404s when the signal does not exist', async () => {
    const repo = new StubRepo(null);
    const app  = buildApp(repo);
    const res  = await app.request('/api/admin/signals/retry/missing', {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('400s when the signal is not in lifecycle=failed', async () => {
    const repo = new StubRepo(signal('s1', SignalLifecycle.Executed));
    const app  = buildApp(repo);
    const res  = await app.request('/api/admin/signals/retry/s1', {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(400);
    expect(repo.retried).toHaveLength(0);
  });

  it('delegates to repo.retry when signal is in lifecycle=failed', async () => {
    const repo = new StubRepo(signal('s1', SignalLifecycle.Failed));
    const app  = buildApp(repo);
    const res  = await app.request('/api/admin/signals/retry/s1', {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    expect(repo.retried).toEqual(['s1']);
  });
});

describe('POST /api/admin/signals/cancel/:id', () => {
  it('404s when the signal does not exist', async () => {
    const repo = new StubRepo(null);
    const app  = buildApp(repo);
    const res  = await app.request('/api/admin/signals/cancel/missing', {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('400s when the signal is in a terminal state (executed/closed/failed/cancelled)', async () => {
    for (const lc of [
      SignalLifecycle.Executed,
      SignalLifecycle.Closed,
      SignalLifecycle.Failed,
      SignalLifecycle.Cancelled,
      SignalLifecycle.Pending,
    ]) {
      const repo = new StubRepo(signal('s1', lc));
      const app  = buildApp(repo);
      const res  = await app.request('/api/admin/signals/cancel/s1', {
        method: 'POST',
        headers: adminHeaders(),
      });
      expect(res.status).toBe(400);
    }
  });

  it('delegates to repo.markFailed(manual_cancel) for queued/executing/approved', async () => {
    for (const lc of [
      SignalLifecycle.Queued,
      SignalLifecycle.Executing,
      SignalLifecycle.Approved,
    ]) {
      const repo = new StubRepo(signal('s1', lc));
      const app  = buildApp(repo);
      const res  = await app.request('/api/admin/signals/cancel/s1', {
        method: 'POST',
        headers: adminHeaders(),
      });
      expect(res.status).toBe(200);
      expect(repo.markedFailed[0]).toMatchObject({ id: 's1', reason: SignalFailureReason.ManualCancel });
    }
  });
});
