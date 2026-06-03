// Inverse-volatility sizing — w_i ∝ 1/σ_i over the strategy's emitted held set. Parity-tested
// against quant-core's solve_inverse_vol (golden vectors in InverseVolOptimiser.test.ts). For
// weighting='inverse_vol' strategies (high_velocity_v1): NO re-selection, NO sector cap — the
// strategy already chose the names; this only sizes them by inverse vol (a risk-parity-lite tilt
// toward calmer names) with a MONTHLY turnover budget (default 1.0 = full rebalance allowed).

export const MAX_MONTHLY_TURNOVER = 1.0;

export interface InverseVolInput {
  volatilities: number[];     // per-ticker annualised σ, aligned to `tickers`
  tickers: string[];
  currentWeights: number[];   // aligned to `tickers`
  maxMonthlyTurnover?: number;
}

export function solveInverseVol(input: InverseVolInput): number[] {
  const { volatilities, tickers, currentWeights } = input;
  const maxTurnover = input.maxMonthlyTurnover ?? MAX_MONTHLY_TURNOVER;
  const n = tickers.length;

  const inv = new Array<number>(n).fill(0);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const v = volatilities[i] ?? 0;
    if (Number.isFinite(v) && v > 0) { const x = 1 / v; inv[i] = x; total += x; }
  }
  if (total <= 0) return new Array<number>(n).fill(0);
  const raw = inv.map((w) => w / total);

  // Monthly turnover guard — at the default budget (1.0) a full rebalance always passes
  // (turnover ≤ 1.0). Mirrors solveLongOnly's blend-toward-current.
  const turnover = raw.reduce((a: number, w: number, i: number) => a + Math.abs(w - (currentWeights[i] ?? 0)), 0) / 2;
  if (turnover > maxTurnover) {
    const blend = maxTurnover / turnover;
    return raw.map((w: number, i: number) => blend * w + (1 - blend) * (currentWeights[i] ?? 0));
  }
  return raw;
}
