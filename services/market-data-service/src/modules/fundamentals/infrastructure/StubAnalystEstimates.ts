// Analyst-estimates provider — STUBBED placeholder (epic pit-fundamentals-lake-rearchitecture,
// Thread C / decision I). The Yahoo source is dropped platform-wide; analyst estimates are not yet
// available from a point-in-time source, so this returns "not yet available" (null) for every
// ticker while preserving the provider interface so a later epic can re-wire it from PIT data
// without touching the route or the portal.
//
// `fetch` always resolves `null` — the same shape the route already treats as "estimates
// unavailable" (it renders the stored QMJ line items and a placeholder for the analyst/growth
// section). The `AnalystEstimates` / `GrowthEstimate` / `RecommendationHistogram` types are kept
// here as the contract a future PIT-backed provider must satisfy.

export interface RecommendationHistogram {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

export interface GrowthEstimate {
  period: string; // '0y' current year, '+1y' next year, etc.
  growth: number | null; // fractional growth estimate
}

export interface AnalystEstimates {
  priceTargetLow: number | null;
  priceTargetMean: number | null;
  priceTargetHigh: number | null;
  numberOfAnalysts: number | null;
  recommendationMean: number | null; // 1=Strong Buy … 5=Sell
  recommendationKey: string | null; // 'buy' | 'hold' | …
  recommendation: RecommendationHistogram | null; // latest-period analyst rating counts
  earningsGrowth: GrowthEstimate[]; // forward EPS growth (current/next year)
  revenueGrowth: GrowthEstimate[]; // forward revenue growth (current/next year)
}

export class StubAnalystEstimates {
  /**
   * Always `null` — analyst estimates are not yet available from a PIT source. The route folds a
   * `null` into the per-ticker payload as `analyst: null`, which the portal renders as a
   * "PIT-sourced — coming soon" placeholder.
   */
  async fetch(_ticker: string): Promise<AnalystEstimates | null> {
    return null;
  }
}
