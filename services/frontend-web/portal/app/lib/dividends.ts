// Pure dividend-history helpers for the Research Fundamentals tab (research-trading-os Task 27).
// Extracted from the tab so the trailing-12m payout math is unit-testable without rendering a
// server component. The Fundamentals tab shows the trailing-12m dividend-per-share (the honest,
// source-only figure) rather than fabricating a yield from a stale price denominator.

export interface DividendRecord {
  date: string // 'YYYY-MM-DD' ex-date
  valuePerShare: number // BASE units (pence already killed at the market-data boundary)
  currency?: string
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Sum of the per-share dividends whose ex-date falls in the year ending at `asOf` (inclusive of
 * `asOf`, exclusive-of-older-than-one-year). `asOf` defaults to the current instant — resolved
 * HERE (a plain module, not a component render path) so the caller's JSX stays free of the
 * impure-`Date.now()`-in-render lint. Non-finite values are skipped. The reported currency is that
 * of the most-recent qualifying payment (the list is single-currency per ticker in practice — LSE
 * pence is already normalised to GBP upstream).
 */
export function trailing12mDividend(
  divs: DividendRecord[],
  asOf: number | null | undefined,
): { total: number; currency?: string; count: number } {
  const ref = asOf == null ? Date.now() : asOf
  const cutoff = ref - YEAR_MS
  // Most-recent-first so `currency` reflects the latest payment.
  const recent = divs
    .filter((d) => {
      const t = Date.parse(d.date)
      return Number.isFinite(t) && t <= ref && t >= cutoff
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
  const total = recent.reduce((s, d) => s + (Number.isFinite(d.valuePerShare) ? d.valuePerShare : 0), 0)
  return { total, currency: recent[0]?.currency, count: recent.length }
}

/** Dividend history most-recent ex-date first (the table render order). */
export function sortDividendsDesc(divs: DividendRecord[]): DividendRecord[] {
  return divs.slice().sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
}
