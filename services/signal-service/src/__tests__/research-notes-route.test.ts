// Route-level tests for the research notebook (T33 §G): GET/PUT/DELETE /admin/api/research/notes/:ticker
// + GET /admin/api/research/notes/backlinks. Pins:
//   - admin auth gate (anon → 401),
//   - PUT then GET round-trips the body + the server-parsed @-links,
//   - the backlink index returns referrer notes for a linked entity,
//   - DELETE removes the note (GET then returns the empty-but-200 shape),
//   - validation on the backlinks query (bad kind / missing ref → 400).
//
// Backed by a small in-memory fake of a single Mongo collection (findOne / updateOne-upsert /
// deleteOne / find().sort().toArray() / createIndex) so the round-trip is a real store exercise, not
// a stub returning canned shapes. Only the RESEARCH_NOTES collection is modelled with state; the
// other collections the router touches (narrative/factor_scores/positions/bars) return empty.

process.env.INTERNAL_SECRET = 'test-internal-secret';
process.env.JWT_SECRET      = 'test-jwt-secret';

import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { signAccessToken } from '@trader/shared-auth';
import { COLLECTIONS } from '@trader/shared-mongo';
import { createResearchRouter, type ResearchRouterDeps } from '../modules/research/routes/research-routes.ts';

let adminJWT: string;
beforeAll(async () => {
    adminJWT = await signAccessToken({ sub: 'tester-admin', role: 'admin' });
});
const adminHeaders = () => ({ Authorization: `Bearer ${adminJWT}`, 'Content-Type': 'application/json' });

interface NoteDoc {
    _id: string;
    body: string;
    links: Array<{ kind: string; ref: string }>;
    updatedBy: string | null;
    updatedAt: number;
}

// An empty chained cursor for the non-notes collections (matches the shape getBars/loadMarketSummary use).
function emptyCursor() {
    return { sort: () => emptyCursor(), limit: () => emptyCursor(), project: () => emptyCursor(), toArray: async () => [] };
}

// In-memory research_notes collection. Supports exactly what MongoResearchNotesStore calls.
function notesCollection(store: Map<string, NoteDoc>) {
    return {
        findOne: async (q: { _id: string }) => store.get(q._id) ?? null,
        updateOne: async (q: { _id: string }, update: { $set: Partial<NoteDoc> }) => {
            const prev = store.get(q._id);
            store.set(q._id, { _id: q._id, body: '', links: [], updatedBy: null, updatedAt: 0, ...prev, ...update.$set });
            return { acknowledged: true, upsertedCount: prev ? 0 : 1 };
        },
        deleteOne: async (q: { _id: string }) => {
            const had = store.delete(q._id);
            return { deletedCount: had ? 1 : 0 };
        },
        find: (q: { links: { $elemMatch: { kind: string; ref: string } } }) => {
            const { kind, ref } = q.links.$elemMatch;
            const matched = [...store.values()].filter((d) => d.links.some((l) => l.kind === kind && l.ref === ref));
            let rows = matched;
            return {
                sort: (s: { updatedAt: number }) => {
                    rows = [...rows].sort((a, b) => (s.updatedAt === -1 ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt));
                    return { toArray: async () => rows };
                },
                toArray: async () => rows,
            };
        },
        createIndex: async () => 'research_notes_backlink',
    };
}

function fakeDb(store: Map<string, NoteDoc>) {
    return {
        collection: (name: string) => {
            if (name === COLLECTIONS.RESEARCH_NOTES) return notesCollection(store);
            // narrative / factor_scores / positions / bars — empty.
            return { findOne: async () => null, find: () => emptyCursor() };
        },
    } as unknown as ResearchRouterDeps['db'];
}

const fakeRedis = { get: async () => null, setEx: async () => undefined } as unknown as ResearchRouterDeps['redis'];

function buildApp(store: Map<string, NoteDoc>) {
    const app = new Hono();
    app.route('/', createResearchRouter({ db: fakeDb(store), redis: fakeRedis, topK: 20, narrativeLlm: null }));
    return app;
}

describe('research notebook routes', () => {
    it('401s an unauthenticated GET / PUT / DELETE / backlinks', async () => {
        const app = buildApp(new Map());
        expect((await app.request('/admin/api/research/notes/AAPL_US_EQ')).status).toBe(401);
        expect((await app.request('/admin/api/research/notes/AAPL_US_EQ', { method: 'PUT', body: '{}' })).status).toBe(401);
        expect((await app.request('/admin/api/research/notes/AAPL_US_EQ', { method: 'DELETE' })).status).toBe(401);
        expect((await app.request('/admin/api/research/notes/backlinks?kind=symbol&ref=AAPL')).status).toBe(401);
    });

    it('GET returns an empty-but-200 note when none exists (editor renders a blank page)', async () => {
        const app = buildApp(new Map());
        const res = await app.request('/admin/api/research/notes/AAPL_US_EQ', { headers: adminHeaders() });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ticker: 'AAPL_US_EQ', body: '', links: [], updatedBy: null, updatedAt: null });
    });

    it('PUT then GET round-trips the body + the server-parsed @-links', async () => {
        const store = new Map<string, NoteDoc>();
        const app = buildApp(store);
        const body = 'Thesis: long under @strategy:factor_rank_v1; watch @symbol:msft and @signal:sig-9.';

        const put = await app.request('/admin/api/research/notes/AAPL_US_EQ', {
            method: 'PUT',
            headers: adminHeaders(),
            body: JSON.stringify({ body }),
        });
        expect(put.status).toBe(200);
        const saved = await put.json();
        expect(saved.ticker).toBe('AAPL_US_EQ');
        expect(saved.body).toBe(body);
        expect(saved.updatedBy).toBe('tester-admin'); // defaulted from the admin caller's sub
        expect(typeof saved.updatedAt).toBe('number');
        expect(saved.links).toEqual([
            { kind: 'strategy', ref: 'factor_rank_v1' },
            { kind: 'symbol', ref: 'MSFT' }, // upper-cased
            { kind: 'signal', ref: 'sig-9' },
        ]);

        const get = await app.request('/admin/api/research/notes/AAPL_US_EQ', { headers: adminHeaders() });
        const fetched = await get.json();
        expect(fetched).toEqual(saved);
    });

    it('PUT honours an explicit updatedBy override in the body', async () => {
        const app = buildApp(new Map());
        const res = await app.request('/admin/api/research/notes/T', {
            method: 'PUT',
            headers: adminHeaders(),
            body: JSON.stringify({ body: 'note', updatedBy: 'okaemii' }),
        });
        expect((await res.json()).updatedBy).toBe('okaemii');
    });

    it('PUT 400s when body is missing or not a string', async () => {
        const app = buildApp(new Map());
        const r1 = await app.request('/admin/api/research/notes/T', { method: 'PUT', headers: adminHeaders(), body: JSON.stringify({}) });
        expect(r1.status).toBe(400);
        const r2 = await app.request('/admin/api/research/notes/T', { method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ body: 42 }) });
        expect(r2.status).toBe(400);
    });

    it('backlink index returns the notes that reference an entity (newest-first)', async () => {
        const store = new Map<string, NoteDoc>();
        const app = buildApp(store);
        // Two notes reference @strategy:factor_rank_v1; one references something else.
        await app.request('/admin/api/research/notes/AAPL_US_EQ', { method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ body: 'a @strategy:factor_rank_v1' }) });
        await app.request('/admin/api/research/notes/MSFT_US_EQ', { method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ body: 'b @strategy:factor_rank_v1 @symbol:AAPL_US_EQ' }) });
        await app.request('/admin/api/research/notes/GOOG_US_EQ', { method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ body: 'c @strategy:high_velocity_v1' }) });

        const res = await app.request('/admin/api/research/notes/backlinks?kind=strategy&ref=factor_rank_v1', { headers: adminHeaders() });
        expect(res.status).toBe(200);
        const out = await res.json();
        expect(out.kind).toBe('strategy');
        expect(out.ref).toBe('factor_rank_v1');
        const referrers = out.notes.map((n: { ticker: string }) => n.ticker).sort();
        expect(referrers).toEqual(['AAPL_US_EQ', 'MSFT_US_EQ']);
        // The referrer payload carries the full note (body + links), so the UI need not re-fetch.
        expect(out.notes[0]).toHaveProperty('body');
        expect(out.notes[0]).toHaveProperty('links');
    });

    it('backlink lookup is symbol-case-insensitive (matches parseLinks upper-casing)', async () => {
        const store = new Map<string, NoteDoc>();
        const app = buildApp(store);
        await app.request('/admin/api/research/notes/N1', { method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ body: 'see @symbol:AAPL' }) });
        // Query with lower-case ref — normaliseRef upper-cases it to find the stored @symbol:AAPL.
        const res = await app.request('/admin/api/research/notes/backlinks?kind=symbol&ref=aapl', { headers: adminHeaders() });
        const out = await res.json();
        expect(out.notes.map((n: { ticker: string }) => n.ticker)).toEqual(['N1']);
    });

    it('backlinks 400s on an unknown kind or a missing ref', async () => {
        const app = buildApp(new Map());
        expect((await app.request('/admin/api/research/notes/backlinks?kind=portfolio&ref=p1', { headers: adminHeaders() })).status).toBe(400);
        expect((await app.request('/admin/api/research/notes/backlinks?kind=symbol', { headers: adminHeaders() })).status).toBe(400);
    });

    it('DELETE removes the note; a subsequent GET returns the empty shape', async () => {
        const store = new Map<string, NoteDoc>();
        const app = buildApp(store);
        await app.request('/admin/api/research/notes/AAPL_US_EQ', { method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ body: 'temp' }) });

        const del = await app.request('/admin/api/research/notes/AAPL_US_EQ', { method: 'DELETE', headers: adminHeaders() });
        expect(del.status).toBe(200);
        expect(await del.json()).toEqual({ ticker: 'AAPL_US_EQ', deleted: true });

        const get = await app.request('/admin/api/research/notes/AAPL_US_EQ', { headers: adminHeaders() });
        expect((await get.json()).body).toBe('');

        // Deleting again is idempotent (deleted:false, still 200).
        const del2 = await app.request('/admin/api/research/notes/AAPL_US_EQ', { method: 'DELETE', headers: adminHeaders() });
        expect(await del2.json()).toEqual({ ticker: 'AAPL_US_EQ', deleted: false });
    });

    it('the backlinks literal segment is NOT captured as a :ticker (route precedence)', async () => {
        const app = buildApp(new Map());
        // GET /notes/backlinks without kind/ref must hit the backlinks handler (400), not the
        // :ticker handler (which would 200 with an empty note named "backlinks").
        const res = await app.request('/admin/api/research/notes/backlinks', { headers: adminHeaders() });
        expect(res.status).toBe(400);
    });
});
