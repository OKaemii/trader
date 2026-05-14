// Admin routes for portal-driven runtime overrides. Gated by internal-token check;
// the api-gateway is the only authorized caller and enforces user-level admin auth.

import { Hono } from 'hono';
import { requireInternalToken } from '@trader/shared-auth/middleware';
import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import { getLiveConfig, invalidateLiveConfig, _envDefaultsForTest } from './live-config.ts';
import type { UniverseManager } from './universe-manager.ts';

interface UniverseOverridesDoc {
  _id: 'singleton';
  adds: string[];
  removes: string[];
  updatedBy: string;
  updatedAt: Date;
}

interface MarketConfigDoc {
  _id: 'singleton';
  barFrequency: 'daily' | 'intraday' | null;
  pollIntervalMs: number | null;
  updatedBy: string;
  updatedAt: Date;
}

const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 24 * 60 * 60_000;

export function createAdminRouter(universeManager: UniverseManager): Hono {
  const r = new Hono();
  r.use('*', requireInternalToken('api-gateway'));

  // ── Universe overrides ────────────────────────────────────────────────────
  r.get('/api/admin/universe/overrides', async (c) => {
    const db = await getMongoDb();
    const doc = await db.collection<UniverseOverridesDoc>(COLLECTIONS.PORTAL_UNIVERSE_OVERRIDES)
      .findOne({ _id: 'singleton' });
    return c.json({
      adds: doc?.adds ?? [],
      removes: doc?.removes ?? [],
      activeUniverse: universeManager.activeTickers,
      sectorMap: universeManager.sectorMap,
      updatedBy: doc?.updatedBy ?? null,
      updatedAt: doc?.updatedAt ?? null,
    });
  });

  r.put('/api/admin/universe/overrides', async (c) => {
    const body = await c.req.json<{ adds?: string[]; removes?: string[]; userId?: string }>();
    const norm = (arr: string[] | undefined) =>
      (arr ?? []).map((t) => t.toUpperCase().trim()).filter(Boolean);
    const adds = norm(body.adds);
    const removes = norm(body.removes);
    const db = await getMongoDb();
    await db.collection(COLLECTIONS.PORTAL_UNIVERSE_OVERRIDES).updateOne(
      { _id: 'singleton' },
      { $set: { adds, removes, updatedBy: body.userId ?? 'unknown', updatedAt: new Date() } },
      { upsert: true },
    );
    return c.json({ ok: true, adds, removes });
  });

  r.post('/api/admin/universe/refresh', async (c) => {
    const tickers = await universeManager.refresh();
    return c.json({ ok: true, universeSize: tickers.length, activeUniverse: tickers });
  });

  // ── Market-data config overrides ──────────────────────────────────────────
  r.get('/api/admin/market-data/config', async (c) => {
    const db = await getMongoDb();
    const doc = await db.collection<MarketConfigDoc>(COLLECTIONS.PORTAL_MARKET_CONFIG)
      .findOne({ _id: 'singleton' });
    const effective = await getLiveConfig();
    return c.json({
      override: {
        barFrequency: doc?.barFrequency ?? null,
        pollIntervalMs: doc?.pollIntervalMs ?? null,
      },
      effective,
      defaults: _envDefaultsForTest(),
      updatedBy: doc?.updatedBy ?? null,
      updatedAt: doc?.updatedAt ?? null,
    });
  });

  r.put('/api/admin/market-data/config', async (c) => {
    const body = await c.req.json<{
      barFrequency?: 'daily' | 'intraday' | null;
      pollIntervalMs?: number | null;
      userId?: string;
    }>();
    if (body.barFrequency != null && !['daily', 'intraday'].includes(body.barFrequency)) {
      return c.json({ error: 'invalid barFrequency' }, 400);
    }
    if (body.pollIntervalMs != null && (body.pollIntervalMs < MIN_POLL_MS || body.pollIntervalMs > MAX_POLL_MS)) {
      return c.json({ error: `pollIntervalMs out of range (${MIN_POLL_MS}..${MAX_POLL_MS})` }, 400);
    }
    const db = await getMongoDb();
    await db.collection(COLLECTIONS.PORTAL_MARKET_CONFIG).updateOne(
      { _id: 'singleton' },
      { $set: {
        barFrequency: body.barFrequency ?? null,
        pollIntervalMs: body.pollIntervalMs ?? null,
        updatedBy: body.userId ?? 'unknown',
        updatedAt: new Date(),
      }},
      { upsert: true },
    );
    invalidateLiveConfig();
    return c.json({ ok: true });
  });

  return r;
}
