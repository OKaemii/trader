import type { Currency } from '@trader/shared-types';

export type FxToGBP = (amount: number, currency: Currency) => Promise<number>;

// Raw balance-sheet + income line items (+ market cap in GBP) — the inputs to the QMJ quality
// screen. We store the RAW items (not pre-computed ratios) so the canonical ratio math lives in
// one place: quant-core `quality.py` for live/replay, `qmj.ts` for the scanner badge. Missing
// items default to 0 downstream, which makes the screen fail-closed (a zero denominator =>
// excluded — quality data we don't have is never a false PASS).
export interface FundamentalsRaw {
  netIncome:          number;   // latest fiscal-YEAR net income (annual, for ROE)
  totalEquity:        number;
  totalDebt:          number;
  currentAssets:      number;
  currentLiabilities: number;
  marketCapGbp:       number;
}

export interface FundamentalsProvider {
  /** Best-effort per-ticker fundamentals. Tickers the provider can't resolve are absent. */
  fetch(tickers: string[]): Promise<Record<string, FundamentalsRaw>>;
}
