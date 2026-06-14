// Pipeline C unit tests (plan ## Task 12): the pure surprise math, the StubConsensusProvider, and the
// wiring's default-stub selection. No Mongo here — the store/route honest-empty shape is exercised in
// consensus-route.test.ts. The load-bearing invariant pinned across all three: a proper surprise
// REQUIRES consensus, so with the stub there is NO surprise (never a fabricated/mechanical value).

import { describe, it, expect } from 'vitest';
import { surprisePct } from '../modules/consensus/application/surprise.ts';
import { StubConsensusProvider } from '../modules/consensus/infrastructure/StubConsensusProvider.ts';
import { buildConsensusStore } from '../modules/consensus/wiring.ts';
import { ConsensusStore } from '../modules/consensus/application/ConsensusStore.ts';

describe('surprisePct — (actual_eps − consensus_eps) / |consensus_eps|', () => {
    it('computes a positive surprise (an EPS beat) as a signed fraction', () => {
        // actual 2.20 vs consensus 2.00 → +0.20 / 2.00 = +0.10 (a 10% beat)
        expect(surprisePct({ actualEps: 2.2, consensusEps: 2.0 })).toBeCloseTo(0.1, 10);
    });

    it('computes a negative surprise (an EPS miss)', () => {
        // actual 1.80 vs consensus 2.00 → −0.20 / 2.00 = −0.10 (a 10% miss)
        expect(surprisePct({ actualEps: 1.8, consensusEps: 2.0 })).toBeCloseTo(-0.1, 10);
    });

    it('uses the ABSOLUTE consensus in the denominator (a beat over a negative consensus is positive)', () => {
        // consensus −0.50 (analysts expect a loss), actual −0.20 (a smaller loss) → beat.
        // (−0.20 − (−0.50)) / |−0.50| = 0.30 / 0.50 = +0.60 — positive because |consensus|, not the
        // raw (negative) consensus, anchors the scale. A signed denominator would flip the sign here.
        expect(surprisePct({ actualEps: -0.2, consensusEps: -0.5 })).toBeCloseTo(0.6, 10);
    });

    it('is exactly 0 when the actual matches the consensus', () => {
        expect(surprisePct({ actualEps: 3.0, consensusEps: 3.0 })).toBe(0);
    });

    it('fails closed (null, never ±Infinity/NaN) when consensus is zero', () => {
        // |0| denominator → undefined surprise. Null is "not computable", never a fabricated 0%.
        expect(surprisePct({ actualEps: 1.0, consensusEps: 0 })).toBeNull();
        expect(surprisePct({ actualEps: 0, consensusEps: 0 })).toBeNull();
    });

    it('fails closed (null) on a non-finite input', () => {
        expect(surprisePct({ actualEps: Number.NaN, consensusEps: 2.0 })).toBeNull();
        expect(surprisePct({ actualEps: 2.0, consensusEps: Number.POSITIVE_INFINITY })).toBeNull();
    });
});

describe('StubConsensusProvider (no-op placeholder — no consensus vendor wired)', () => {
    it('returns an empty map for any tickers (no consensus available)', async () => {
        const provider = new StubConsensusProvider();
        expect(await provider.fetch(['AAPL_US_EQ', 'MSFT_US_EQ', 'SHELl_EQ'])).toEqual({});
        expect(await provider.fetch([])).toEqual({});
    });
});

describe('buildConsensusStore (wiring — stub is the default, swap-ready)', () => {
    it("selects the stub provider for 'stub' (the default) and yields a ConsensusStore", () => {
        expect(buildConsensusStore('stub')).toBeInstanceOf(ConsensusStore);
    });

    it("falls back to the stub for a not-yet-implemented provider ('eodhd' is the swap slot)", () => {
        // The eodhd branch is the documented one-provider swap point; until it's wired the wiring
        // degrades to the stub (warns) rather than throwing — a cold consensus feed never breaks boot.
        expect(buildConsensusStore('eodhd')).toBeInstanceOf(ConsensusStore);
    });
});
