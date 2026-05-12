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
  const { scores, tickers, sectors, currentWeights } = input;
  const n = tickers.length;

  // Step 1: Select names with positive composite scores (no synthetic shorts)
  const eligible = scores.map((s, i) => ({ score: s, i })).filter((x) => x.score > 0);
  if (eligible.length === 0) return new Array(n).fill(0);

  // Step 2: Proportional weights from raw scores, capped at maxSingleName
  const rawWeights = new Array(n).fill(0);
  const posScoreSum = eligible.reduce((a, x) => a + x.score, 0);
  for (const { score, i } of eligible) {
    rawWeights[i] = Math.min(score / posScoreSum, RISK_LIMITS.maxSingleName);
  }

  // Step 3: Sector neutrality — cap each GICS sector at maxSectorConcentration
  const sectorTotals: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    sectorTotals[sectors[i]] = (sectorTotals[sectors[i]] ?? 0) + rawWeights[i];
  }
  for (let i = 0; i < n; i++) {
    const sectorTotal = sectorTotals[sectors[i]];
    if (sectorTotal > RISK_LIMITS.maxSectorConcentration) {
      rawWeights[i] *= RISK_LIMITS.maxSectorConcentration / sectorTotal;
    }
  }

  // Step 4: Re-normalise to sum = 1 (fully invested long-only)
  const total = rawWeights.reduce((a, b) => a + b, 0);
  const normalised = rawWeights.map((w) => (total > 0 ? w / total : 0));

  // Step 5: Turnover guard — blend toward current weights if turnover exceeds budget
  const turnover = normalised.reduce((a, w, i) => a + Math.abs(w - currentWeights[i]), 0) / 2;
  if (turnover > RISK_LIMITS.maxWeeklyTurnover) {
    const blendFactor = RISK_LIMITS.maxWeeklyTurnover / turnover;
    return normalised.map((w, i) => blendFactor * w + (1 - blendFactor) * currentWeights[i]);
  }

  return normalised;
  // NOTE: volatility targeting and drawdown-halt checks are applied in RiskEngine.validate()
  // before signals are dispatched. This function produces candidate weights only.
}
