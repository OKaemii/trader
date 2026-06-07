// Research module — portal-facing, admin-gated market intelligence. signal-service owns the
// /admin/api/market/* AND /admin/api/research/* prefixes (both added to its ingress alongside
// /admin/api/signals). T30 (narrative), T33 (notes) and T25 (by-ticker) extend the SAME module and
// public surface, so the wiring is kept thin and the maths pure (see application/*).
//
// GET /admin/api/market/summary → a typed, deterministic payload of sector returns + factor
// leadership (cross-sectional means of factor_scores) + breadth (% above 200-DMA) + concentration
// (HHI vs target). All inputs are read from shared Mongo — factor_scores is written by
// strategy-engine and read here directly (no cross-service HTTP, the contract from card #64).
//
// GET/PUT/DELETE /admin/api/research/notes/:ticker + GET /admin/api/research/notes/backlinks (T33
// §G) → the research notebook: a per-entity markdown note whose `@`-links are parsed into a backlink
// index ("notes referencing entity X"). Persisted in COLLECTIONS.RESEARCH_NOTES (Task 5 contract).

import { Hono } from 'hono';
import { parseAdminHeaders } from '@trader/shared-auth/middleware';
import { getBars, aggregateBars } from '@trader/shared-bars';
import { sma, pctReturn } from '@trader/shared-indicators';
import { COLLECTIONS } from '@trader/shared-mongo';
import type { Logger } from '@trader/core';
import type { Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import {
    computeMarketSummary,
    type FactorScoreRow,
    type MarketSummary,
    type SectorReturnInput,
} from '../application/MarketSummary.ts';
import {
    generateNarrative,
    type NarrativeChat,
    type NarrativeSource,
} from '../application/MarketNarrative.ts';
import { isResearchLinkKind, normaliseRef } from '../application/ResearchNotes.ts';
import { MongoResearchNotesStore } from '../infrastructure/MongoResearchNotesStore.ts';

// The SPDR sector-ETF reference set powering the sector heatmap. Mirror of market-data-service's
// sector-etfs.ts (the source of truth for the tracked-but-untradeable ETF set) — duplicated here as
// a small constant so the read stays a local shared-Mongo bar fetch, not a cross-service HTTP hop.
// Keep in sync with services/market-data-service/src/modules/sectors/sector-etfs.ts.
const SECTOR_ETFS: Array<{ ticker: string; sector: string }> = [
    { ticker: 'XLK_US_EQ',  sector: 'Technology' },
    { ticker: 'XLF_US_EQ',  sector: 'Financials' },
    { ticker: 'XLV_US_EQ',  sector: 'Health Care' },
    { ticker: 'XLY_US_EQ',  sector: 'Consumer Discretionary' },
    { ticker: 'XLI_US_EQ',  sector: 'Industrials' },
    { ticker: 'XLP_US_EQ',  sector: 'Consumer Staples' },
    { ticker: 'XLE_US_EQ',  sector: 'Energy' },
    { ticker: 'XLU_US_EQ',  sector: 'Utilities' },
    { ticker: 'XLB_US_EQ',  sector: 'Materials' },
    { ticker: 'XLRE_US_EQ', sector: 'Real Estate' },
    { ticker: 'XLC_US_EQ',  sector: 'Communication Services' },
];

const DMA_PERIOD = 200;

export interface ResearchRouterDeps {
    db: Db;
    redis: RedisClientType;
    /** Held-position target (per-strategy top-K) for the concentration HHI target. */
    topK: number;
    /**
     * LLM seam for the market narrative (GET /admin/api/market/narrative). null when DEEPSEEK_API_KEY
     * is unset — the narrative then degrades to the deterministic template (never blocks the page).
     */
    narrativeLlm?: NarrativeChat | null;
    logger?: Logger;
}

interface NarrativeCacheDoc {
    tradingDay: string;
    narrative: string;
    source: NarrativeSource;
    summary: MarketSummary;
    generatedAt: number;
}

/** UTC date string (YYYY-MM-DD) used as the narrative cache key — regenerate on a new UTC day. */
function utcDay(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10);
}

/** Latest completed-week return for one sector ETF, from its daily series. */
async function sectorLatestReturn(
    deps: ResearchRouterDeps,
    etf: { ticker: string; sector: string },
): Promise<SectorReturnInput> {
    const daily = await getBars(deps.redis, deps.db, etf.ticker, 'daily', '1y');
    const weekly = aggregateBars(daily, 'weekly');
    const closes = weekly.map((b) => b.close);
    const latest =
        closes.length >= 2 ? pctReturn(closes[closes.length - 2]!, closes[closes.length - 1]!) : null;
    return { sector: etf.sector, ticker: etf.ticker, latest };
}

/** True/false/null = above / at-or-below / insufficient-history vs the 200-DMA, for one ticker. */
async function breadthFlag(deps: ResearchRouterDeps, ticker: string): Promise<boolean | null> {
    const daily = await getBars(deps.redis, deps.db, ticker, 'daily', '1y');
    const closes = daily.map((b) => b.close);
    if (closes.length < DMA_PERIOD) return null;
    const ma = sma(closes, DMA_PERIOD);
    const lastMa = ma[ma.length - 1];
    const lastClose = closes[closes.length - 1];
    if (lastMa === null || lastMa === undefined || lastClose === undefined) return null;
    return lastClose > lastMa;
}

/**
 * Read the most recent factor_scores cycle: find the max observation_ts, then every row stamped
 * with it. factor_scores is strategy-engine's per-cycle write (card #64); read directly here.
 */
async function latestFactorCycle(
    db: Db,
): Promise<{ rows: FactorScoreRow[]; cycleTs: number | null }> {
    const coll = db.collection(COLLECTIONS.FACTOR_SCORES);
    const newest = await coll
        .find({}, { projection: { observation_ts: 1 } })
        .sort({ observation_ts: -1 })
        .limit(1)
        .toArray();
    const cycleTs = newest.length > 0 ? (newest[0]!.observation_ts as number) : null;
    if (cycleTs === null) return { rows: [], cycleTs: null };
    const docs = await coll
        .find({ observation_ts: cycleTs }, { projection: { _id: 0, ticker: 1, factors: 1 } })
        .toArray();
    const rows: FactorScoreRow[] = docs.map((d) => ({
        ticker: String(d.ticker),
        factors: (d.factors ?? {}) as FactorScoreRow['factors'],
    }));
    return { rows, cycleTs };
}

/** Current portfolio weights from the synced positions collection (Money in listing currency). */
async function positionWeights(db: Db): Promise<number[]> {
    const docs = await db
        .collection(COLLECTIONS.POSITIONS)
        .find({}, { projection: { currentValue: 1 } })
        .toArray();
    // Weight by |currentValue.amount|. Cross-currency books are a minor distortion here (the HHI
    // is a concentration heuristic, not a NAV figure); the per-name relative magnitude dominates.
    const amounts = docs.map((d) => {
        const v = d.currentValue as { amount?: unknown } | undefined;
        return typeof v?.amount === 'number' && Number.isFinite(v.amount) ? Math.abs(v.amount) : 0;
    });
    const total = amounts.reduce((a, v) => a + v, 0);
    return total > 0 ? amounts.map((v) => v / total) : [];
}

/**
 * Read all inputs from shared Mongo (sector ETF bars, latest factor cycle, breadth flags, position
 * weights) and run the pure aggregation. Shared by the /summary endpoint and the narrative endpoint
 * (which is CONSTRAINED to exactly these numbers — so it must build the prose from the same payload).
 */
async function loadMarketSummary(deps: ResearchRouterDeps): Promise<MarketSummary> {
    const [sectorReturns, factorCycle, weights] = await Promise.all([
        Promise.all(SECTOR_ETFS.map((etf) => sectorLatestReturn(deps, etf))),
        latestFactorCycle(deps.db),
        positionWeights(deps.db),
    ]);

    // Breadth over exactly the latest factor cycle's universe — the same names the strategy
    // ranked this cycle. Empty pre-backfill ⇒ an honest empty breadth read.
    const breadthFlags = await Promise.all(
        factorCycle.rows.map((row) => breadthFlag(deps, row.ticker)),
    );

    return computeMarketSummary({
        sectorReturns,
        factorRows: factorCycle.rows,
        factorCycleTs: factorCycle.cycleTs,
        breadthFlags,
        positionWeights: weights,
        topK: deps.topK,
    });
}

export function createResearchRouter(deps: ResearchRouterDeps): Hono {
    const r = new Hono();
    const narrativeColl = deps.db.collection<NarrativeCacheDoc>(COLLECTIONS.MARKET_NARRATIVE);
    const notesStore = new MongoResearchNotesStore(deps.db);

    r.get('/admin/api/market/summary', parseAdminHeaders, async (c) => {
        return c.json(await loadMarketSummary(deps));
    });

    // GET /admin/api/market/narrative — the data-grounded hybrid prose (locked decision #8). Cached
    // per UTC day (the portal_* singleton pattern); ?refresh=1 regenerates on demand. The prose is
    // CONSTRAINED to the numbers in /admin/api/market/summary — a post-check in generateNarrative
    // rejects any invented figure and falls back to the deterministic template, so the page is never
    // blocked by an LLM outage or hallucination.
    r.get('/admin/api/market/narrative', parseAdminHeaders, async (c) => {
        const forceRefresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
        const today = utcDay(Date.now());

        if (!forceRefresh) {
            const cached = await narrativeColl.findOne({ _id: 'singleton' } as never);
            if (cached && cached.tradingDay === today) {
                return c.json({
                    narrative: cached.narrative,
                    source: cached.source,
                    asOf: cached.summary.asOf,
                    tradingDay: cached.tradingDay,
                    generatedAt: cached.generatedAt,
                    cached: true,
                    summary: cached.summary,
                });
            }
        }

        const summary = await loadMarketSummary(deps);
        const { narrative, source } = await generateNarrative(
            summary,
            deps.narrativeLlm ?? null,
            (reason, detail) =>
                deps.logger?.warn({ reason, ...detail }, 'market narrative llm fell back to template'),
        );

        const doc: NarrativeCacheDoc = { tradingDay: today, narrative, source, summary, generatedAt: Date.now() };
        // Best-effort cache write — a Mongo hiccup must not block the page. The narrative is already
        // computed; serve it regardless of whether the upsert lands.
        await narrativeColl
            .updateOne({ _id: 'singleton' } as never, { $set: doc }, { upsert: true })
            .catch((err) => deps.logger?.warn({ err: String(err) }, 'market narrative cache write failed'));

        return c.json({
            narrative,
            source,
            asOf: summary.asOf,
            tradingDay: today,
            generatedAt: doc.generatedAt,
            cached: false,
            summary,
        });
    });

    // ── Research notebook (T33 §G) ────────────────────────────────────────────────────────────────
    // GET /admin/api/research/notes/backlinks?kind=&ref= — "notes referencing entity X". Registered
    // BEFORE the /:ticker route so the literal `backlinks` segment is never captured as a :ticker
    // param. Returns the referrer notes (with their full body + links) newest-first.
    r.get('/admin/api/research/notes/backlinks', parseAdminHeaders, async (c) => {
        const kind = c.req.query('kind') ?? '';
        const rawRef = c.req.query('ref') ?? '';
        if (!isResearchLinkKind(kind)) {
            return c.json({ error: 'kind must be one of strategy|signal|symbol' }, 400);
        }
        if (rawRef.length === 0) {
            return c.json({ error: 'ref is required' }, 400);
        }
        // Normalise the ref the SAME way parseLinks stored it (symbol upper-cased) so the lookup hits.
        const ref = normaliseRef(kind, rawRef);
        const notes = await notesStore.backlinks(kind, ref);
        return c.json({ kind, ref, notes });
    });

    // GET /admin/api/research/notes/:ticker — read the note for an entity. A missing note is NOT a
    // 404: the editor renders a blank page, so we return an empty-but-200 shape (body '', no links).
    r.get('/admin/api/research/notes/:ticker', parseAdminHeaders, async (c) => {
        const ticker = c.req.param('ticker');
        if (!ticker) return c.json({ error: 'ticker is required' }, 400);
        const note = await notesStore.get(ticker);
        return c.json(note ?? { ticker, body: '', links: [], updatedBy: null, updatedAt: null });
    });

    // PUT /admin/api/research/notes/:ticker — upsert the markdown body. The `@`-links are parsed
    // server-side out of the body into the persisted `links` array (the body is the source of
    // truth; the client never sends links). updatedBy defaults to the admin caller's `sub`, with an
    // optional body override. Returns the saved note (parsed links + stamped updatedAt) so the
    // editor can echo the authoritative state without a re-read.
    r.put('/admin/api/research/notes/:ticker', parseAdminHeaders, async (c) => {
        const ticker = c.req.param('ticker');
        if (!ticker) return c.json({ error: 'ticker is required' }, 400);
        const payload = (await c.req.json().catch(() => null)) as { body?: unknown; updatedBy?: unknown } | null;
        if (!payload || typeof payload.body !== 'string') {
            return c.json({ error: 'body (markdown string) is required' }, 400);
        }
        // parseAdminHeaders stamps the verified claims onto the context (c.set('user', …)). The Hono
        // generic isn't augmented with that var, so read it through a narrow cast.
        const caller = (c.get as (k: string) => { sub?: string } | undefined)('user');
        const updatedBy =
            typeof payload.updatedBy === 'string' && payload.updatedBy.length > 0
                ? payload.updatedBy
                : (caller?.sub ?? null);
        const note = await notesStore.put(ticker, payload.body, updatedBy);
        return c.json(note);
    });

    // DELETE /admin/api/research/notes/:ticker — remove a note (UI delete + QA cleanup). Idempotent:
    // deleting an absent note returns deleted:false, still 200.
    r.delete('/admin/api/research/notes/:ticker', parseAdminHeaders, async (c) => {
        const ticker = c.req.param('ticker');
        if (!ticker) return c.json({ error: 'ticker is required' }, 400);
        const deleted = await notesStore.delete(ticker);
        return c.json({ ticker, deleted });
    });

    return r;
}
