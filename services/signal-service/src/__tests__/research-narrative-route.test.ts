// Route-level tests for GET /admin/api/market/narrative — the data-grounded hybrid (T30). Pins:
//   - admin auth gate (parseAdminHeaders) — anon never reaches it,
//   - cache HIT: a fresh-UTC-day cached doc is served verbatim, the LLM is NOT called and the bars
//     are NOT re-read (the portal_* singleton pattern),
//   - cache MISS / new-day: regenerates, writes the singleton, returns cached:false,
//   - ?refresh=1 bypasses a fresh-day cache and regenerates.
//
// We feed a fake Db whose narrative collection returns the cache doc and whose other collections
// return empty (so loadMarketSummary yields an all-empty pre-first-cycle summary deterministically),
// and a fake redis (get→null, setEx→noop) so getBars falls through to the empty Mongo read.

process.env.INTERNAL_SECRET = 'test-internal-secret';
process.env.JWT_SECRET      = 'test-jwt-secret';

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import { signAccessToken } from '@trader/shared-auth';
import { COLLECTIONS } from '@trader/shared-mongo';
import { createResearchRouter, type ResearchRouterDeps } from '../modules/research/routes/research-routes.ts';
import type { NarrativeChat } from '../modules/research/application/MarketNarrative.ts';

let adminJWT: string;
beforeAll(async () => {
    adminJWT = await signAccessToken({ sub: 'tester', role: 'admin' });
});
const adminHeaders = () => ({ Authorization: `Bearer ${adminJWT}` });

const today = () => new Date().toISOString().slice(0, 10);

// A find() cursor that yields a fixed array via the chained shape getBars/loadMarketSummary use.
function cursor(rows: unknown[]) {
    return {
        sort: () => cursor(rows),
        limit: () => cursor(rows),
        project: () => cursor(rows),
        toArray: async () => rows,
    };
}

// Tracks the upsert the route performs so we can assert the singleton was cached.
interface FakeState {
    narrativeDoc: Record<string, unknown> | null;
    upserts: Array<Record<string, unknown>>;
    findOneCalls: number;
}

function fakeDb(state: FakeState) {
    return {
        collection: (name: string) => {
            if (name === COLLECTIONS.MARKET_NARRATIVE) {
                return {
                    findOne: async () => { state.findOneCalls += 1; return state.narrativeDoc; },
                    updateOne: async (_f: unknown, update: { $set: Record<string, unknown> }) => {
                        state.upserts.push(update.$set);
                        state.narrativeDoc = { _id: 'singleton', ...update.$set };
                        return { acknowledged: true };
                    },
                };
            }
            // factor_scores / positions / ohlcv_bars — all empty.
            return { find: () => cursor([]) };
        },
    } as unknown as ResearchRouterDeps['db'];
}

const fakeRedis = {
    get: async () => null,
    setEx: async () => undefined,
} as unknown as ResearchRouterDeps['redis'];

function buildApp(over: Partial<ResearchRouterDeps>, state: FakeState) {
    const app = new Hono();
    app.route('/', createResearchRouter({
        db: fakeDb(state),
        redis: fakeRedis,
        topK: 20,
        narrativeLlm: null,
        ...over,
    }));
    return app;
}

describe('GET /admin/api/market/narrative', () => {
    it('401s without an admin token', async () => {
        const state: FakeState = { narrativeDoc: null, upserts: [], findOneCalls: 0 };
        const res = await buildApp({}, state).request('/admin/api/market/narrative');
        expect(res.status).toBe(401);
    });

    it('serves a fresh-day cached narrative verbatim WITHOUT calling the LLM or re-reading bars', async () => {
        const cachedSummary = {
            asOf: 123, sectorReturns: [], factorLeadership: [], breadth: {}, concentration: {},
        };
        const state: FakeState = {
            narrativeDoc: {
                _id: 'singleton', tradingDay: today(), narrative: 'cached prose',
                source: 'llm', summary: cachedSummary, generatedAt: 999,
            },
            upserts: [], findOneCalls: 0,
        };
        // An LLM that would FAIL the test if invoked — proves the cache short-circuits before it.
        const llm: NarrativeChat = { chat: vi.fn(async () => { throw new Error('LLM must not be called on a cache hit'); }) };
        const res = await buildApp({ narrativeLlm: llm }, state).request('/admin/api/market/narrative', { headers: adminHeaders() });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ narrative: 'cached prose', source: 'llm', cached: true, tradingDay: today() });
        expect(llm.chat).not.toHaveBeenCalled();
        expect(state.upserts).toHaveLength(0);  // no re-write on a hit
    });

    it('regenerates + caches when there is no cached doc (cache miss)', async () => {
        const state: FakeState = { narrativeDoc: null, upserts: [], findOneCalls: 0 };
        // No LLM ⇒ deterministic template; empty Mongo ⇒ a pre-first-cycle summary.
        const res = await buildApp({ narrativeLlm: null }, state).request('/admin/api/market/narrative', { headers: adminHeaders() });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.cached).toBe(false);
        expect(body.source).toBe('template');
        expect(body.tradingDay).toBe(today());
        expect(typeof body.narrative).toBe('string');
        expect(body.narrative.length).toBeGreaterThan(0);
        // the singleton was upserted with the day's narrative
        expect(state.upserts).toHaveLength(1);
        expect(state.upserts[0]).toMatchObject({ tradingDay: today(), source: 'template' });
    });

    it('regenerates when the cached doc is from a PRIOR day (does not serve a stale narrative)', async () => {
        const state: FakeState = {
            narrativeDoc: {
                _id: 'singleton', tradingDay: '2000-01-01', narrative: 'yesteryear prose',
                source: 'llm', summary: { asOf: 1 }, generatedAt: 1,
            },
            upserts: [], findOneCalls: 0,
        };
        const res = await buildApp({ narrativeLlm: null }, state).request('/admin/api/market/narrative', { headers: adminHeaders() });
        const body = await res.json();
        expect(body.cached).toBe(false);
        expect(body.narrative).not.toBe('yesteryear prose');
        expect(body.tradingDay).toBe(today());
        expect(state.upserts).toHaveLength(1);
    });

    it('?refresh=1 bypasses a fresh-day cache and regenerates', async () => {
        const state: FakeState = {
            narrativeDoc: {
                _id: 'singleton', tradingDay: today(), narrative: 'cached prose',
                source: 'llm', summary: { asOf: 1 }, generatedAt: 1,
            },
            upserts: [], findOneCalls: 0,
        };
        const res = await buildApp({ narrativeLlm: null }, state).request('/admin/api/market/narrative?refresh=1', { headers: adminHeaders() });
        const body = await res.json();
        expect(body.cached).toBe(false);
        expect(state.findOneCalls).toBe(0);     // refresh skips the cache read entirely
        expect(state.upserts).toHaveLength(1);
    });
});
