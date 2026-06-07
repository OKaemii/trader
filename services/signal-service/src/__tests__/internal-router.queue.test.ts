// Route-level tests for the queue endpoints exposed on signal-service. Verifies:
//   - X-Internal-Token gating (caller must be 'trading-service')
//   - Happy-path payload shape returned to the dispatcher
//   - Empty-queue claim returns {signal:null} (not 404)
//   - markFailed wire-format honours arbitrary reason strings (cast at router layer)
//
// The repository is stubbed with the queue-method signatures we care about — we're
// not retesting the atomic claim itself here (covered by MongoSignalRepository.queue.test.ts).

process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from 'hono';
import { mintInternalJwt } from '@trader/shared-auth';
import { createInternalRouter } from '../modules/signals/routes/internal.ts';
import type { ISignalRepository } from '../modules/signals/domain/ISignalRepository.ts';
import { TradeSignal } from '../modules/signals/domain/TradeSignal.ts';
import type { ISignalPublisher } from '../modules/signals/domain/ISignalPublisher.ts';
import { SignalLifecycle, SignalFailureReason } from '@trader/shared-types';

class StubRepo implements ISignalRepository {
  public claimed: TradeSignal | null = null;
  public requeuedIds: string[] = [];
  public failedCalls: Array<{ id: string; reason: SignalFailureReason; detail?: string }> = [];
  public sweptCount = 0;

  async save() {}
  async findById(id: string) {
    return new TradeSignal({
      id, timestamp: 0, ticker: 'X', strategy_id: 's', action: 'BUY',
      confidence: 0.5, targetWeight: 0.01, rationale: '{}', lifecycle: SignalLifecycle.Failed,
    });
  }
  async findRecent() { return []; }
  async approve() {}
  async markExecuted() {}
  async markClosed() {}
  async findOpenBuysByTicker() { return []; }
  async decrementExecutedQuantity() {}
  async setTargetWeight() {}
  async markQueued() {}
  async claimNextQueued() { return this.claimed; }
  async requeue(id: string) { this.requeuedIds.push(id); }
  async markFailed(id: string, reason: any, detail?: string) { this.failedCalls.push({ id, reason, detail }); }
  async retry() {}
  async sweepStaleExecuting(_ms: number) { return this.sweptCount; }
  async findByLifecycle() { return []; }
  async findByTicker() { return []; }
}

class StubPublisher implements ISignalPublisher {
  published: TradeSignal[] = [];
  async publish(s: TradeSignal) { this.published.push(s); }
}

function buildApp(repo: StubRepo) {
  const app = new Hono();
  app.route('/', createInternalRouter({
    findRecent:    { execute: async () => [] },
    approveSignal: { execute: async () => {} } as any,
    riskEngine:    {} as any,
    signalRepo:    repo,
    publisher:     new StubPublisher(),
  }));
  return app;
}

// Bearer helpers — Phase 4 audience-JWT migration. requireInternal returns 401 (Unauthorized)
// when no token is present, 401 when the audience doesn't match. requireCaller returns 403
// (Forbidden) when the JWT is valid but the `sub` doesn't match any allowed caller.
const tradingBearer = async (): Promise<string> => `Bearer ${await mintInternalJwt('trading-service')}`;
const signalBearer  = async (): Promise<string> => `Bearer ${await mintInternalJwt('signal-service')}`;

describe('queue endpoints', () => {
  let repo: StubRepo;
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { repo = new StubRepo(); app = buildApp(repo); });

  describe('POST /internal/api/signals/queue/claim', () => {
    it('rejects no-token requests with 401', async () => {
      const res = await app.request('/internal/api/signals/queue/claim', { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('rejects wrong-caller tokens with 403 (only trading-service)', async () => {
      const res = await app.request('/internal/api/signals/queue/claim', {
        method: 'POST',
        headers: { Authorization: await signalBearer() },
      });
      expect(res.status).toBe(403);
    });

    it('returns {signal:null} when queue is empty', async () => {
      const res = await app.request('/internal/api/signals/queue/claim', {
        method: 'POST',
        headers: { Authorization: await tradingBearer() },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ signal: null });
    });

    it('returns claimed signal payload with required fields', async () => {
      repo.claimed = new TradeSignal({
        id: 'sig-1', timestamp: 12345, ticker: 'AAPL_US_EQ', strategy_id: 'test',
        action: 'BUY', confidence: 0.5, targetWeight: 0.01, rationale: '{}',
        entryPrice: 100, lifecycle: SignalLifecycle.Executing, attempts: 1,
      });
      const res = await app.request('/internal/api/signals/queue/claim', {
        method: 'POST',
        headers: { Authorization: await tradingBearer() },
      });
      const body = await res.json();
      expect(body.signal.id).toBe('sig-1');
      expect(body.signal.ticker).toBe('AAPL_US_EQ');
      expect(body.signal.action).toBe('BUY');
      expect(body.signal.attempts).toBe(1);
      expect(body.signal.entryPrice).toBe(100);
    });
  });

  describe('POST /internal/api/signals/queue/:id/requeue', () => {
    it('rejects missing token with 401', async () => {
      const res = await app.request('/internal/api/signals/queue/abc/requeue', { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('delegates to repo.requeue with the path id', async () => {
      const res = await app.request('/internal/api/signals/queue/abc/requeue', {
        method: 'POST',
        headers: { Authorization: await tradingBearer() },
      });
      expect(res.status).toBe(200);
      expect(repo.requeuedIds).toEqual(['abc']);
    });
  });

  describe('POST /internal/api/signals/queue/:id/failed', () => {
    it('delegates reason + detail to repo.markFailed', async () => {
      const res = await app.request('/internal/api/signals/queue/xyz/failed', {
        method: 'POST',
        headers: { Authorization: await tradingBearer(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: SignalFailureReason.MarketDrift, detail: 'delta=2.5%' }),
      });
      expect(res.status).toBe(200);
      expect(repo.failedCalls).toEqual([{ id: 'xyz', reason: SignalFailureReason.MarketDrift, detail: 'delta=2.5%' }]);
    });

    it('rejects wrong caller with 403', async () => {
      const res = await app.request('/internal/api/signals/queue/xyz/failed', {
        method: 'POST',
        headers: { Authorization: await signalBearer(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: SignalFailureReason.BrokerRejected }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /internal/api/signals/queue/sweep', () => {
    it('returns reverted count from repo.sweepStaleExecuting', async () => {
      repo.sweptCount = 3;
      const res = await app.request('/internal/api/signals/queue/sweep', {
        method: 'POST',
        headers: { Authorization: await tradingBearer(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ thresholdMs: 60_000 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reverted).toBe(3);
    });

    it('tolerates empty body — defaults thresholdMs to 60s', async () => {
      const res = await app.request('/internal/api/signals/queue/sweep', {
        method: 'POST',
        headers: { Authorization: await tradingBearer() },
      });
      expect(res.status).toBe(200);
    });
  });
});
