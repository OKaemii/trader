// Route-level test for the telemetry-snapshot internal endpoint. Verifies:
//   - X-Internal-Token gating (caller must be 'notification-service' — not trading)
//   - Query parameter `since` is parsed by zod and threaded into the use-case
//   - Response shape matches the contract (zod-validated client side too)
//   - 500 when the use-case isn't wired (defensive guard for tests that omit it)
//
// The use-case itself is stubbed; the Mongo round-trip is covered separately by
// integration tests against a real db.

process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { mintInternalJwt } from '@trader/shared-auth';
import type { TelemetrySnapshotResponse } from '@trader/contracts';
import { createInternalRouter } from '../modules/signals/routes/internal.ts';
import type { GetTelemetrySnapshotUseCase } from '../modules/signals/application/GetTelemetrySnapshot.ts';
import type { ISignalRepository } from '../modules/signals/domain/ISignalRepository.ts';
import type { ISignalPublisher } from '../modules/signals/domain/ISignalPublisher.ts';

const stubRepo: ISignalRepository = {
  save: async () => {},
  findById: async () => null,
  findRecent: async () => [],
  approve: async () => {},
  markExecuted: async () => {},
  markClosed: async () => {},
  findOpenBuysByTicker: async () => [],
  decrementExecutedQuantity: async () => {},
  setTargetWeight: async () => {},
  markQueued: async () => {},
  claimNextQueued: async () => null,
  requeue: async () => {},
  markFailed: async () => {},
  retry: async () => {},
  sweepStaleExecuting: async () => 0,
  findByLifecycle: async () => [],
  findByTicker: async () => [],
};

const stubPublisher: ISignalPublisher = { publish: async () => {} };
const stubLogger: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function buildApp(useCase?: GetTelemetrySnapshotUseCase) {
  const app = new Hono();
  app.route('/', createInternalRouter({
    signalRepo: stubRepo,
    publisher:  stubPublisher,
    logger:     stubLogger,
    telemetrySnapshot: useCase,
  }));
  return app;
}

const notificationBearer = async () => `Bearer ${await mintInternalJwt('notification-service')}`;
const tradingBearer      = async () => `Bearer ${await mintInternalJwt('trading-service')}`;

const sampleResponse: TelemetrySnapshotResponse = {
  since: 0,
  computedAt: 1700000000000,
  realisedSinceLast: {
    closedSignals: 2,
    pnlGbp: 123.45,
    bestPick:  { ticker: 'AAPL_US_EQ', pnlPct: 0.05, pnlGbp: 100 },
    worstPick: { ticker: 'BARCl_EQ',   pnlPct: -0.02, pnlGbp: -23.55 },
  },
  lifecycleCounters: {
    pending: 0, approved: 1, queued: 2, executing: 0, executed: 3, closed: 4, failed: 1, cancelled: 0,
  },
  openPositions: { count: 3, mtmGbp: 5000, fxDegraded: false },
  risk: {
    navGbp: 12345,
    hwmGbp: 13000,
    dailyLossPct: 0.01,
    drawdownPct: 0.05,
    circuit: { open: false, reason: null },
  },
  decay: {
    health: 'healthy',
    metrics: {
      rollingSharpe30d: 1.2,
      hitRate30d:       0.55,
      turnoverRatio:    0.8,
      icTStat:          1.5,
      featureDriftKL:   0.2,
      computedAt:       1700000000000,
    },
  },
  history: {
    previousDigestAt:       1699913600000,
    signalsSinceLastDigest: 4,
    priorAppearances:       {},
  },
};

describe('GET /internal/api/signals/telemetry-snapshot', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const app = buildApp({ execute: async () => sampleResponse } as GetTelemetrySnapshotUseCase);
    const res = await app.request('/internal/api/signals/telemetry-snapshot?since=0');
    expect(res.status).toBe(401);
  });

  it('rejects non-notification callers with 403', async () => {
    const app = buildApp({ execute: async () => sampleResponse } as GetTelemetrySnapshotUseCase);
    const res = await app.request('/internal/api/signals/telemetry-snapshot?since=0', {
      headers: { Authorization: await tradingBearer() },
    });
    expect(res.status).toBe(403);
  });

  it('rejects malformed `since` with 400 (zod validator)', async () => {
    const app = buildApp({ execute: async () => sampleResponse } as GetTelemetrySnapshotUseCase);
    const res = await app.request('/internal/api/signals/telemetry-snapshot?since=not-a-number', {
      headers: { Authorization: await notificationBearer() },
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing `since` with 400 (zod requires the query param)', async () => {
    const app = buildApp({ execute: async () => sampleResponse } as GetTelemetrySnapshotUseCase);
    const res = await app.request('/internal/api/signals/telemetry-snapshot', {
      headers: { Authorization: await notificationBearer() },
    });
    expect(res.status).toBe(400);
  });

  it('threads `since` into the use-case and returns its response verbatim', async () => {
    let captured = -1;
    const app = buildApp({ execute: async (since: number) => { captured = since; return sampleResponse; } } as GetTelemetrySnapshotUseCase);
    const res = await app.request('/internal/api/signals/telemetry-snapshot?since=1700000000000', {
      headers: { Authorization: await notificationBearer() },
    });
    expect(res.status).toBe(200);
    expect(captured).toBe(1700000000000);
    const body = await res.json();
    expect(body.realisedSinceLast.closedSignals).toBe(2);
    expect(body.realisedSinceLast.pnlGbp).toBe(123.45);
    expect(body.openPositions.mtmGbp).toBe(5000);
    expect(body.lifecycleCounters.closed).toBe(4);
    expect(body.decay.health).toBe('healthy');
    expect(body.history.signalsSinceLastDigest).toBe(4);
  });

  it('threads `tickers` (csv) + `strategyId` query params into the use-case', async () => {
    let capturedSince  = -1;
    let capturedOpts: { tickers?: readonly string[]; strategyId?: string } | undefined;
    const app = buildApp({
      execute: async (since: number, opts?: { tickers?: readonly string[]; strategyId?: string }) => {
        capturedSince = since; capturedOpts = opts; return sampleResponse;
      },
    } as unknown as GetTelemetrySnapshotUseCase);
    const res = await app.request(
      '/internal/api/signals/telemetry-snapshot?since=1700000000000&tickers=AAPL_US_EQ,MSFT_US_EQ&strategyId=factor_rank_v1',
      { headers: { Authorization: await notificationBearer() } },
    );
    expect(res.status).toBe(200);
    expect(capturedSince).toBe(1700000000000);
    expect(capturedOpts?.tickers).toEqual(['AAPL_US_EQ', 'MSFT_US_EQ']);
    expect(capturedOpts?.strategyId).toBe('factor_rank_v1');
  });

  it('500s when the use-case isn\'t wired (defensive — production always injects it)', async () => {
    const app = buildApp(undefined);
    const res = await app.request('/internal/api/signals/telemetry-snapshot?since=0', {
      headers: { Authorization: await notificationBearer() },
    });
    expect(res.status).toBe(500);
  });
});
