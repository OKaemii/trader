// Analyst-consensus source — Pipeline C of the estimates engine (plan
// agent-docs/plans/analyst-free-estimates-engine.md ## Task 12). Consensus is the gold-standard
// FactSet/Bloomberg/LSEG-class feed of forward analyst estimates AND the realised earnings-surprise
// inputs. The platform has no consensus vendor wired, so the SHIPPED provider is StubConsensusProvider
// (returns {} — no consensus, honestly).
//
// Why an interface around an empty stub: a proper earnings surprise REQUIRES consensus
// (surprise_pct = (actual_eps − consensus_eps)/|consensus_eps|) — a mechanical SUE-vs-seasonal-RW or
// EAR proxy is NOT a proper surprise and must NEVER masquerade as one. So the surprise signal is
// "not built rather than faked": the stores + routes exist but stay EMPTY until a real consensus feed
// lands. This interface is the SINGLE swap point — wiring an `EodhdConsensusProvider` (EODHD's
// Fundamentals Data Feed carries analyst estimates for US names) or a gold-standard vendor later is a
// one-provider change in wiring.ts, with no store/route/collection edits.
//
// Provider contract: like the earnings provider, a provider OMITS a ticker entirely when it has no
// consensus — it never guesses — so "unknown" stays distinguishable from "no analysts cover this name"
// downstream. An empty map (the stub's only output) means the surprise store accretes nothing.

/** A forward analyst-consensus estimate for one (ticker, fiscal_period, metric). */
export interface ConsensusEstimate {
    /** Fiscal period the estimate targets, e.g. 'FY2026' / 'Q3-2026'. */
    fiscalPeriod: string;
    /** The estimated metric — 'eps' for the surprise path; revenue/ebitda for future legs. */
    metric: string;
    /** Mean/median consensus value in the metric's native unit (EPS in instrument currency/share). */
    consensus: number;
    /** Number of contributing analysts (the dispersion/quality denominator). */
    numAnalysts: number;
    /** UTC ms the consensus snapshot was taken — the point-in-time the estimate was knowable. */
    snapshotDate: number;
}

/** The realised actual that closes out a consensus estimate, enabling a surprise. Sourced WITH the
 *  consensus (a vendor reports actual alongside estimate); the lake's reported EPS is NOT a substitute
 *  here, because a surprise is only meaningful against the consensus that anchored it. */
export interface ConsensusActual {
    fiscalPeriod: string;
    /** Reported actual EPS for the period, native unit. */
    actualEps: number;
}

/** What a consensus provider returns for a batch of tickers — estimates and (optionally) the realised
 *  actuals. A real vendor populates both; the stub returns the empty shape for every name. */
export interface ConsensusData {
    estimates: ConsensusEstimate[];
    actuals: ConsensusActual[];
}

export interface ConsensusProvider {
    /** Per-ticker consensus. A name with no analyst coverage is OMITTED from the map (never an empty
     *  `{estimates:[],actuals:[]}` masquerading as "covered, no estimates"). The stub returns {}. */
    fetch(tickers: string[]): Promise<Record<string, ConsensusData>>;
}
