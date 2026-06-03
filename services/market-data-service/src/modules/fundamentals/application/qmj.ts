// Canonical QMJ (Quality-Minus-Junk) thresholds + ratio math. Mirrored by quant-core's
// quality.py (live/replay) — a sanctioned trivial duplication: both reference these three rules,
// documented by the constants. Fail-closed: a zero/missing denominator yields no ratios (=> the
// name fails the screen), so quality data we don't have is never a false PASS.

import type { FundamentalsRaw } from '../infrastructure/FundamentalsProvider.ts';

export const ROE_MIN = 0.10;   // Profitability: Return on Equity
export const DE_MAX  = 2.0;    // Solvency:      Debt / Equity
export const CR_MIN  = 1.0;    // Liquidity:     Current Ratio

export interface QmjRatios { roe: number; debtToEquity: number; currentRatio: number; }

export function computeRatios(r: FundamentalsRaw): QmjRatios | null {
  if (r.totalEquity <= 0 || r.currentLiabilities <= 0) return null;   // fail-closed denominators
  return {
    roe:          r.netIncome / r.totalEquity,
    debtToEquity: r.totalDebt / r.totalEquity,
    currentRatio: r.currentAssets / r.currentLiabilities,
  };
}

export function qualityPass(r: FundamentalsRaw): boolean {
  const x = computeRatios(r);
  return !!x && x.roe >= ROE_MIN && x.debtToEquity <= DE_MAX && x.currentRatio >= CR_MIN;
}
