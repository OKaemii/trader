// Route-level test for /admin/api/market-data/technical — the History page's supplemental
// EODHD technical overlays (T28, §H). The route is a thin metered passthrough; we inject a fake
// fetcher so no HTTP round-trip to EODHD happens, and assert the contract the portal proxy +
// HistoryTab depend on: auth gate, ticker/func validation, allow-list, and the { ticker, func,
// points } shape.

process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { signAccessToken } from '@trader/shared-auth';
import { createTechnicalRouter, TECHNICAL_FUNCS, type TechnicalFetcher } from '../routes.ts';
import type { EodhdTechnicalPoint } from '../../bars/infrastructure/providers/eodhd-client.ts';

const adminToken = async () => `Bearer ${await signAccessToken({ sub: 'admin-user', role: 'admin' })}`;

function buildApp(fetcher: TechnicalFetcher) {
  const app = new Hono();
  app.route('/', createTechnicalRouter(fetcher));
  return app;
}

const samplePoints: EodhdTechnicalPoint[] = [
  { date: '2026-06-05', values: { macd: 1.23, signal: 0.98, divergence: 0.25 } },
  { date: '2026-06-06', values: { macd: 1.31, signal: 1.02, divergence: 0.29 } },
];

describe('GET /admin/api/market-data/technical', () => {
  it('rejects an unauthenticated request (401)', async () => {
    const app = buildApp(async () => samplePoints);
    const res = await app.request('/admin/api/market-data/technical?ticker=AAPL_US_EQ&func=macd');
    expect(res.status).toBe(401);
  });

  it('400s when ticker is missing', async () => {
    const app = buildApp(async () => samplePoints);
    const res = await app.request('/admin/api/market-data/technical?func=macd', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ticker/);
  });

  it('400s when func is missing', async () => {
    const app = buildApp(async () => samplePoints);
    const res = await app.request('/admin/api/market-data/technical?ticker=AAPL_US_EQ', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/func/);
  });

  it('400s (and never fetches) for a func outside the allow-list', async () => {
    const fetcher = vi.fn<TechnicalFetcher>(async () => samplePoints);
    const app = buildApp(fetcher);
    const res = await app.request('/admin/api/market-data/technical?ticker=AAPL_US_EQ&func=rm', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.allowed).toEqual([...TECHNICAL_FUNCS]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns { ticker, func, points } for an allow-listed func', async () => {
    const fetcher = vi.fn<TechnicalFetcher>(async () => samplePoints);
    const app = buildApp(fetcher);
    const res = await app.request('/admin/api/market-data/technical?ticker=AAPL_US_EQ&func=macd', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticker).toBe('AAPL_US_EQ');
    expect(body.func).toBe('macd');
    expect(body.points).toEqual(samplePoints);
    expect(fetcher).toHaveBeenCalledWith('AAPL_US_EQ', 'macd', {});
  });

  it('passes only the period/from/to params through to the fetcher', async () => {
    const fetcher = vi.fn<TechnicalFetcher>(async () => samplePoints);
    const app = buildApp(fetcher);
    const res = await app.request(
      '/admin/api/market-data/technical?ticker=AAPL_US_EQ&func=atr&period=14&from=2026-01-01&junk=x',
      { headers: { Authorization: await adminToken() } },
    );
    expect(res.status).toBe(200);
    // `junk` is dropped; only the whitelisted params reach the metered client.
    expect(fetcher).toHaveBeenCalledWith('AAPL_US_EQ', 'atr', { period: '14', from: '2026-01-01' });
  });

  it('lower-cases the func before validating + dispatching', async () => {
    const fetcher = vi.fn<TechnicalFetcher>(async () => samplePoints);
    const app = buildApp(fetcher);
    const res = await app.request('/admin/api/market-data/technical?ticker=AAPL_US_EQ&func=MACD', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    expect(fetcher).toHaveBeenCalledWith('AAPL_US_EQ', 'macd', {});
  });

  it('passes an empty points list straight through (budget-exhaustion degrade)', async () => {
    const app = buildApp(async () => []);
    const res = await app.request('/admin/api/market-data/technical?ticker=AAPL_US_EQ&func=beta', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).points).toEqual([]);
  });
});
