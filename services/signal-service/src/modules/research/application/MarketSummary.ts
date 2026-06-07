// Pure, deterministic market-summary aggregation. The route fetches the raw inputs (sector ETF
// returns, the latest factor-scores cycle, per-name 200-DMA state, current portfolio weights) and
// hands them here; this file does the maths only, so every number on the Research/Workspace surface
// is unit-tested independently of Mongo/Redis. T30's market narrative is constrained to exactly the
// numbers this payload exposes — nothing is invented downstream — so the shape is a contract.

// ---- Inputs (all pre-fetched by the route; pure in, pure out) --------------------------------

/** One sector ETF's latest completed-week return, already computed from its daily series. */
export interface SectorReturnInput {
    sector: string;          // human label, e.g. 'Technology'
    ticker: string;          // the ETF ticker, e.g. 'XLK_US_EQ'
    latest: number | null;   // most-recent completed week's % return; null when history is too short
}

/** The per-factor leg of one factor_scores row (see COLLECTIONS.FACTOR_SCORES / card #64). */
export interface FactorLeg {
    raw: number | null;      // cross-sectional z-score
    pct: number | null;      // cross-sectional percentile [0,100]
    source: string | null;
}

/** One ticker's row from the latest factor_scores cycle. */
export interface FactorScoreRow {
    ticker: string;
    factors: {
        momentum?: FactorLeg;
        volatility?: FactorLeg;
        value?: FactorLeg;
        quality?: FactorLeg;
    };
}

/** The four canonical research factors, in display order. */
export const FACTOR_KEYS = ['momentum', 'volatility', 'value', 'quality'] as const;
export type FactorKey = (typeof FACTOR_KEYS)[number];

export interface MarketSummaryInput {
    /** Sector ETF latest-week returns (already computed from daily bars by the route). */
    sectorReturns: SectorReturnInput[];
    /** Every ticker's row from the most recent factor_scores cycle. */
    factorRows: FactorScoreRow[];
    /** The cycle (knowledge) time of the factor_scores rows, ms; null when the store is empty. */
    factorCycleTs: number | null;
    /**
     * Per-name 200-DMA state for the breadth read: true = last close above its 200-day SMA,
     * false = at/below, null = insufficient history (excluded from the breadth denominator).
     */
    breadthFlags: (boolean | null)[];
    /** Current portfolio weights (fractions summing to ~1) for the concentration HHI. */
    positionWeights: number[];
    /** Held-position target (per-strategy top-K). The HHI target is 1/topK (equal-weight ideal). */
    topK: number;
}

// ---- Output payload (the contract T30's narrative is constrained to) -------------------------

export interface SectorReturnRow {
    sector: string;
    ticker: string;
    latest: number | null;
}

export interface FactorLeadershipRow {
    factor: FactorKey;
    /** Cross-sectional mean of this factor's `pct` across all names with a finite value. */
    meanPct: number | null;
    /** Cross-sectional mean of this factor's `raw` z-score across all names with a finite value. */
    meanRaw: number | null;
    /** How many names contributed a finite `pct` to meanPct. */
    count: number;
}

export interface BreadthSummary {
    /** Fraction of names above their 200-DMA, over names with sufficient history [0,1]; null if none. */
    pctAbove200dma: number | null;
    aboveCount: number;
    /** Names with enough history to evaluate (the denominator). */
    totalWithHistory: number;
}

export interface ConcentrationSummary {
    /** Herfindahl–Hirschman index of current weights = Σ wᵢ². [0,1]; null when no positions. */
    hhi: number | null;
    /** Equal-weight target HHI = 1/topK (the concentration the optimiser aims at). */
    targetHhi: number | null;
    /** hhi − targetHhi (positive ⇒ more concentrated than target); null when either side is null. */
    excess: number | null;
    positionCount: number;
}

export interface MarketSummary {
    /** Knowledge time of the factor cycle the leadership numbers are drawn from (ms); null if empty. */
    asOf: number | null;
    sectorReturns: SectorReturnRow[];
    factorLeadership: FactorLeadershipRow[];
    breadth: BreadthSummary;
    concentration: ConcentrationSummary;
}

// ---- Maths -----------------------------------------------------------------------------------

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Mean of finite values; null when none are finite. */
function meanFinite(values: (number | null | undefined)[]): { mean: number | null; count: number } {
    let sum = 0;
    let count = 0;
    for (const v of values) {
        if (isFiniteNum(v)) {
            sum += v;
            count += 1;
        }
    }
    return { mean: count > 0 ? sum / count : null, count };
}

function computeFactorLeadership(rows: FactorScoreRow[]): FactorLeadershipRow[] {
    return FACTOR_KEYS.map((factor) => {
        const legs = rows.map((r) => r.factors?.[factor]);
        const pct = meanFinite(legs.map((l) => l?.pct ?? null));
        const raw = meanFinite(legs.map((l) => l?.raw ?? null));
        return { factor, meanPct: pct.mean, meanRaw: raw.mean, count: pct.count };
    });
}

function computeBreadth(flags: (boolean | null)[]): BreadthSummary {
    let above = 0;
    let total = 0;
    for (const f of flags) {
        if (f === null) continue;       // insufficient history — not in the denominator
        total += 1;
        if (f) above += 1;
    }
    return {
        pctAbove200dma: total > 0 ? above / total : null,
        aboveCount: above,
        totalWithHistory: total,
    };
}

function computeConcentration(weights: number[], topK: number): ConcentrationSummary {
    const finite = weights.filter(isFiniteNum);
    const gross = finite.reduce((a, w) => a + Math.abs(w), 0);
    // HHI on the *normalised* weights so a not-fully-invested book (gross < 1) isn't reported as
    // artificially diversified. Identity when gross ≈ 1.
    const hhi = gross > 0 ? finite.reduce((a, w) => a + (Math.abs(w) / gross) ** 2, 0) : null;
    const targetHhi = topK > 0 ? 1 / topK : null;
    const excess = hhi !== null && targetHhi !== null ? hhi - targetHhi : null;
    return { hhi, targetHhi, excess, positionCount: finite.length };
}

/**
 * Build the typed, deterministic market summary from pre-fetched inputs. No I/O — the route owns
 * the Mongo/Redis reads and feeds this. Same inputs ⇒ same payload, byte-for-byte.
 */
export function computeMarketSummary(input: MarketSummaryInput): MarketSummary {
    const sectorReturns: SectorReturnRow[] = input.sectorReturns
        .map((s) => ({ sector: s.sector, ticker: s.ticker, latest: s.latest }))
        // Strongest latest-week return first; nulls sink to the bottom (deterministic tiebreak by ticker).
        .sort((a, b) => {
            const av = a.latest ?? -Infinity;
            const bv = b.latest ?? -Infinity;
            if (av !== bv) return bv - av;
            return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
        });

    return {
        asOf: input.factorCycleTs,
        sectorReturns,
        factorLeadership: computeFactorLeadership(input.factorRows),
        breadth: computeBreadth(input.breadthFlags),
        concentration: computeConcentration(input.positionWeights, input.topK),
    };
}
