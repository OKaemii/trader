// Long-only cross-sectional ranking + sector-neutral portfolio construction (v1 heuristic).
// Market-neutral long/short is Phase 3. Full convex QP (Section 30) replaces this once the
// signal is validated. The interface (RankingInput → weights[]) is stable — solver is a drop-in.

export interface RankingInput {
  scores: number[];              // composite signal score per asset (higher = more bullish)
  tickers: string[];
  sectors: string[];             // GICS sector per ticker
  currentWeights: number[];      // current portfolio weights (for turnover penalty)
  targetVol: number;             // target annualised volatility (e.g. 0.10)
  covariance: number[][];        // shrunk covariance matrix (Ledoit-Wolf)
  // Truncate the candidate set to the top K highest-scoring positive names. Names
  // outside top-K go to weight=0 — produces clean SELLs for demoted holdings and
  // skips emission for new noise. 0 / undefined disables (legacy full-universe).
  topK?: number;
  // Inverse-vol sizing (when weighting='inverse_vol'): per-ticker annualised σ aligned to
  // `tickers`. PortfolioConstructor routes to solveInverseVol instead of solveLongOnly.
  volatilities?: number[];
  weighting?: 'score_proportional' | 'inverse_vol';
}

export const RISK_LIMITS = {
  maxSingleName:          0.15,   // 15% max per name
  maxSectorConcentration: 0.30,   // 30% in any single GICS sector
  volatilityTarget:       0.10,   // 10% annualised portfolio σ
  maxDailyLoss:           0.03,   // halt if NAV falls 3% intraday
  maxDrawdownHalt:        0.10,   // halt at 10% drawdown from HWM
  maxWeeklyTurnover:      0.20,   // 20% of portfolio per week
  minConfidence:          0.30,   // discard signals below this threshold
  confidenceStaleDays:    90,     // confidence → 0 if model not retrained within N days
} as const;

export function solveLongOnly(input: RankingInput): number[] {
  const { scores, tickers, sectors, currentWeights, topK } = input;
  const n = tickers.length;

  // Step 1: Select names with positive composite scores (no synthetic shorts)
  let eligible = scores.map((s, i) => ({ score: s, i })).filter((x) => x.score > 0);
  if (eligible.length === 0) return new Array(n).fill(0);

  // Step 1b: Top-K truncation. Sort by score descending and take the K best. The rest
  // get weight=0 → demoted holdings produce SELL, marginal candidates don't produce BUY.
  //
  // Paper alignment: agent-docs/research/mathematical-foundations.md §4 and §6.1 both
  // explicitly state the system is designed for n = 20–60 held positions (the
  // Marchenko–Pastur eigenvalue threshold and Ledoit–Wolf n/T ≈ 0.08–0.24 reasoning
  // both assume this band). The 192-ticker UNIVERSE_MAX_SIZE is the *screening pool*,
  // not the held set — top-K is the missing step that bridges screening → held at the
  // size the paper actually analyses. K=20 sits at the lower bound; raising K past 60
  // would push n/T out of the well-conditioned zone the §6.1 analysis depends on.
  //
  // Operational note: at sub-£20k NAV (a regime the paper does not model — see §12.2,
  // capacity ceiling £5–20M) this step is also what lifts per-position weight from
  // ~1% to ~5%, clearing T212's per-instrument minTradeQuantity floor.
  if (topK && topK > 0 && eligible.length > topK) {
    eligible = eligible.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  // Step 2: Proportional weights from raw scores, capped at maxSingleName
  const rawWeights = new Array(n).fill(0);
  const posScoreSum = eligible.reduce((a, x) => a + x.score, 0);
  for (const { score, i } of eligible) {
    rawWeights[i] = Math.min(score / posScoreSum, RISK_LIMITS.maxSingleName);
  }

  // Step 3: Sector neutrality — cap each GICS sector at maxSectorConcentration
  const sectorTotals: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const sector = sectors[i] ?? 'UNKNOWN';
    sectorTotals[sector] = (sectorTotals[sector] ?? 0) + (rawWeights[i] ?? 0);
  }
  for (let i = 0; i < n; i++) {
    const sector = sectors[i] ?? 'UNKNOWN';
    const sectorTotal = sectorTotals[sector] ?? 0;
    if (sectorTotal > RISK_LIMITS.maxSectorConcentration) {
      rawWeights[i] = (rawWeights[i] ?? 0) * (RISK_LIMITS.maxSectorConcentration / sectorTotal);
    }
  }

  // Step 4: Re-normalise to sum = 1 (fully invested long-only)
  const total = rawWeights.reduce((a, b) => a + b, 0);
  const normalised = rawWeights.map((w) => (total > 0 ? w / total : 0));

  // Step 5: Turnover guard — blend toward current weights if turnover exceeds budget
  const turnover = normalised.reduce((a: number, w: number, i: number) => a + Math.abs(w - (currentWeights[i] ?? 0)), 0) / 2;
  if (turnover > RISK_LIMITS.maxWeeklyTurnover) {
    const blendFactor = RISK_LIMITS.maxWeeklyTurnover / turnover;
    return normalised.map((w: number, i: number) => blendFactor * w + (1 - blendFactor) * (currentWeights[i] ?? 0));
  }

  return normalised;
  // NOTE: volatility targeting and drawdown-halt checks are applied in RiskEngine.validate()
  // before signals are dispatched. This function produces candidate weights only.
}
