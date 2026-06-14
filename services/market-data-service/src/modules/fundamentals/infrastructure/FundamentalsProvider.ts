import type { Currency } from '@trader/shared-types';

export type FxToGBP = (amount: number, currency: Currency) => Promise<number>;

// Raw balance-sheet + income line items (+ market cap in GBP) — the inputs to the QMJ quality
// screen. We store the RAW items (not pre-computed ratios) so the canonical ratio math lives in
// one place: quant-core `quality.py` for live/replay, `qmj.ts` for the scanner badge. The five QMJ
// inputs default to 0 downstream, which makes the screen fail-closed (a zero denominator =>
// excluded — quality data we don't have is never a false PASS).
//
// `marketCapGbp` is the exception: it is NOT a QMJ input (the ratio math never reads it), and a £0
// company cannot trade, so 0 is never a real cap — only a fabricated one. An uncomputable cap
// (genuinely missing shares / pre-data as-of) is carried as `null`, which the display formatters
// render as `—` (ScannerPanel `fmtCap`, Research `gbpCompact`), instead of a misleading £0.
export interface FundamentalsRaw {
  netIncome:          number;        // latest fiscal-YEAR net income (annual, for ROE)
  totalEquity:        number;
  totalDebt:          number;
  currentAssets:      number;
  currentLiabilities: number;
  marketCapGbp:       number | null; // null = uncomputable cap (renders `—`, never a fabricated £0)
}

// Per-name outcome of a fetch, so a caching consumer can converge instead of re-trying a name that
// can never resolve. Distinguishing the three is what stops the QMJ refresh loop spinning forever on
// fail-closed / no-EDGAR names (it would otherwise count every name with no row as eternally stale):
//   - `hit`      — resolved; a `FundamentalsRaw` is present in `values`.
//   - `terminal` — attempted, but this name can never resolve from this provider: a non-US name (no
//                  EDGAR, no Yahoo substitute) or a US name the lake returned a miss for (no CIK / no
//                  facts, e.g. TCEHY / SPCX). Safe to tombstone — it is NOT a transient gap.
//   - `outage`   — the upstream was unreachable / non-2xx / malformed for this name's batch, so its
//                  resolvability is unknown. Do NOT tombstone (that would hide a coverable name until
//                  the TTL); retry on the next cycle.
export type NameStatus = 'hit' | 'terminal' | 'outage';

// A fetch result that surfaces the upstream HTTP outcome distinctly from an empty body. `status`
// carries one entry per *input* ticker (so a consumer can decide tombstone-vs-retry without
// re-deriving the provider's routing); `values` carries only the `hit` names (the existing
// fail-closed map shape — un-resolved names stay absent from it).
export interface FundamentalsFetchResult {
  values: Record<string, FundamentalsRaw>;
  status: Record<string, NameStatus>;
}

export interface FundamentalsProvider {
  /**
   * Best-effort per-ticker fundamentals. `values` holds the resolved (`hit`) names — names the
   * provider can't resolve stay absent from it, exactly as before. `status` additionally classifies
   * every input ticker `hit | terminal | outage`, so a caching consumer can converge: tombstone the
   * `terminal` names (they can never resolve), leave `outage` names untouched (retry next cycle).
   */
  fetch(tickers: string[]): Promise<FundamentalsFetchResult>;

  /**
   * Optional per-name provenance for the most recent `fetch`: the concrete upstream a ticker's
   * data came from (e.g. `pit-edgar` vs the `yahoo` fall-back under the `pit` provider), so the
   * cache can persist an honest per-name source rather than one blanket mode string. Providers that
   * resolve every name from a single upstream (Yahoo, EODHD) omit it — the cache then stamps its
   * configured mode, which is already the truth for them. Only meaningful right after a `fetch`.
   */
  sourceOf?(ticker: string): string | undefined;
}
