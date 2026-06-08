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

  /**
   * Optional per-name provenance for the most recent `fetch`: the concrete upstream a ticker's
   * data came from (e.g. `pit-edgar` vs the `yahoo` fall-back under the `pit` provider), so the
   * cache can persist an honest per-name source rather than one blanket mode string. Providers that
   * resolve every name from a single upstream (Yahoo, EODHD) omit it — the cache then stamps its
   * configured mode, which is already the truth for them. Only meaningful right after a `fetch`.
   */
  sourceOf?(ticker: string): string | undefined;
}
