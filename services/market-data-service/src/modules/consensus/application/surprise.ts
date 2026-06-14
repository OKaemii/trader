// The earnings-surprise calculation — pure, fail-closed (plan ## Task 12; research § Decouple into
// three pipelines, "A proper earnings surprise REQUIRES consensus").
//
//   surprise_pct = (actual_eps − consensus_eps) / |consensus_eps|
//
// This is the ONLY honest definition of a surprise: it is measured against the analyst consensus that
// anchored expectations. A mechanical SUE-vs-seasonal-RW or EAR proxy is NOT a surprise and must not be
// computed here. So this function is only ever called when a consensus_eps EXISTS (a Pipeline C row) —
// with the shipped stub there is no consensus, so it is never invoked and the earnings_surprise store
// stays empty.
//
// Fail-closed denominator: |consensus_eps| in the denominator means a zero (or non-finite) consensus
// makes the percentage undefined — we return null rather than ±Infinity/NaN, the same "never fabricate
// a number from a missing/zero denominator" rule the QMJ screen and the PIT market-cap enrichment
// follow. A null result is "surprise not computable for this row", never a 0% surprise.

/** A consensus + actual pair for one (ticker, fiscal_period). */
export interface SurpriseInput {
    actualEps: number;
    consensusEps: number;
}

/**
 * `(actual_eps − consensus_eps) / |consensus_eps|` as a signed fraction (0.05 = +5% beat).
 * Returns `null` when the consensus denominator is zero or either input is non-finite — never a
 * fabricated 0% and never ±Infinity/NaN. With no consensus there is no surprise to compute.
 */
export function surprisePct(input: SurpriseInput): number | null {
    const { actualEps, consensusEps } = input;
    if (!Number.isFinite(actualEps) || !Number.isFinite(consensusEps)) return null;
    const denom = Math.abs(consensusEps);
    if (denom === 0) return null; // zero consensus → undefined surprise (fail-closed, no false PASS)
    return (actualEps - consensusEps) / denom;
}
