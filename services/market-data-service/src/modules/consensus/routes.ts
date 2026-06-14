// Pipeline C consensus admin routes (portal-facing). These back the Research › Fundamentals
// surprise/estimate-revision fields, which render the honest "requires consensus — not sourced" state
// while Pipeline C is stubbed (plan ## Task 12). With the StubConsensusProvider both stores are empty,
// so every read returns the honest empty shape — `consensus: []` / `surprises: []` — never a fabricated
// surprise. The `requiresConsensus` flag is the wire signal the portal renders the marker from.

import { Hono } from 'hono';
import { parseAdminHeaders } from '@trader/shared-auth/middleware';
import type { ConsensusStore } from './application/ConsensusStore.ts';

export function createConsensusRouter(store: ConsensusStore): Hono {
    const r = new Hono();
    // Gate all three reads. `/consensus/*` covers the per-ticker estimate route but NOT the sibling
    // `/consensus-coverage` (no shared path segment), so gate the coverage path explicitly too.
    r.use('/admin/api/market-data/consensus/*', parseAdminHeaders);
    r.use('/admin/api/market-data/consensus-coverage', parseAdminHeaders);
    r.use('/admin/api/market-data/earnings-surprise/*', parseAdminHeaders);

    // Forward analyst-consensus estimates for one ticker — empty while Pipeline C is stubbed.
    r.get('/admin/api/market-data/consensus/:ticker', async (c) => {
        const ticker = c.req.param('ticker');
        const consensus = await store.estimatesFor(ticker);
        return c.json({
            ticker,
            requiresConsensus: true, // honest marker: no consensus vendor wired (Pipeline C stubbed)
            consensus: consensus.map((d) => ({
                fiscalPeriod: d.fiscalPeriod,
                metric: d.metric,
                consensus: d.consensus,
                numAnalysts: d.numAnalysts,
                snapshotDate: d.snapshotDate,
                source: d.source,
            })),
        });
    });

    // Realised earnings surprises for one ticker — empty while Pipeline C is stubbed (a proper surprise
    // REQUIRES consensus; no mechanical SUE/EAR proxy is ever served here).
    r.get('/admin/api/market-data/earnings-surprise/:ticker', async (c) => {
        const ticker = c.req.param('ticker');
        const surprises = await store.surprisesFor(ticker);
        return c.json({
            ticker,
            requiresConsensus: true,
            surprises: surprises.map((d) => ({
                fiscalPeriod: d.fiscalPeriod,
                actualEps: d.actualEps,
                consensusEps: d.consensusEps,
                surprisePct: d.surprisePct,
                source: d.source,
            })),
        });
    });

    // Pipeline C coverage — both counts 0 while stubbed; `requiresConsensus` states why.
    r.get('/admin/api/market-data/consensus-coverage', async (c) => {
        const coverage = await store.coverage();
        return c.json({ ...coverage, requiresConsensus: true });
    });

    return r;
}
