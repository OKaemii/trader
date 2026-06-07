// Yahoo analyst estimates — the additive, may-trail "what the street expects" snapshot the
// Research Fundamentals tab shows alongside the QMJ line items. Distinct from the QMJ provider
// (which feeds the quality factor): this is DISPLAY-ONLY, never enters factor math, and is
// best-effort — a Yahoo session blip yields `null`, not an error, so the tab still renders the
// stored fundamentals.
//
// Reuses the shared quoteSummary session (cookie+crumb) — the same machinery the QMJ provider
// uses — so there is no second Yahoo-auth implementation. Modules:
//   financialData      → analyst price target (low/mean/high) + recommendation mean/key
//   recommendationTrend→ latest strong-buy…sell analyst rating histogram
//   earningsTrend      → forward EPS + revenue growth estimates (current-year / next-year)

import type { QuoteSummaryFetcher } from '../../bars/infrastructure/providers/yahoo-quote-summary.ts';
import { toYahooSymbol, isBlacklisted } from '../../bars/infrastructure/providers/yahoo-client.ts';
import { log } from '../../../logger.ts';

const MODULES = ['financialData', 'recommendationTrend', 'earningsTrend'];

// Yahoo wraps numbers as { raw, fmt }; accept the wrapped form or a bare number.
function rawNum(node: unknown): number | null {
  if (typeof node === 'number') return Number.isFinite(node) ? node : null;
  if (node && typeof node === 'object' && 'raw' in (node as Record<string, unknown>)) {
    const r = (node as { raw?: unknown }).raw;
    return typeof r === 'number' && Number.isFinite(r) ? r : null;
  }
  return null;
}

function str(node: unknown): string | null {
  return typeof node === 'string' && node.length > 0 ? node : null;
}

export interface RecommendationHistogram {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

export interface GrowthEstimate {
  period: string; // '0y' current year, '+1y' next year, etc. (Yahoo's `period` key)
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

// `earningsTrend.trend[]` carries both an EPS (`earningsEstimate`) and a revenue
// (`revenueEstimate`) growth figure per forward period. We surface the current-year (`0y`) and
// next-year (`+1y`) rows — the ones an operator actually reads — and leave the quarterly rows out.
const FORWARD_PERIODS = new Set(['0y', '+1y']);

function extractGrowth(trend: unknown[], estimateKey: string): GrowthEstimate[] {
  const out: GrowthEstimate[] = [];
  for (const row of trend) {
    const r = row as Record<string, unknown>;
    const period = str(r.period);
    if (!period || !FORWARD_PERIODS.has(period)) continue;
    const est = r[estimateKey] as Record<string, unknown> | undefined;
    out.push({ period, growth: rawNum(est?.growth) });
  }
  return out;
}

export class YahooAnalystEstimates {
  constructor(private readonly qs: QuoteSummaryFetcher) {}

  /** Best-effort estimates for one ticker. `null` on a blacklisted symbol, 404, or any error. */
  async fetch(ticker: string): Promise<AnalystEstimates | null> {
    try {
      const sym = toYahooSymbol(ticker);
      if (isBlacklisted(sym)) return null;
      const result = await this.qs.fetchModules(sym, MODULES);
      if (!result) return null;
      return this.extract(result);
    } catch (err) {
      log.warn(`[fundamentals/analyst] ${ticker}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private extract(r: Record<string, unknown>): AnalystEstimates {
    const fin = r.financialData as Record<string, unknown> | undefined;

    // recommendationTrend.trend[0] is the most recent period ('0m').
    const recTrendArr = (r.recommendationTrend as Record<string, unknown> | undefined)?.trend;
    const latestRec = Array.isArray(recTrendArr) ? (recTrendArr[0] as Record<string, unknown> | undefined) : undefined;
    const recommendation: RecommendationHistogram | null = latestRec
      ? {
          strongBuy: rawNum(latestRec.strongBuy) ?? 0,
          buy: rawNum(latestRec.buy) ?? 0,
          hold: rawNum(latestRec.hold) ?? 0,
          sell: rawNum(latestRec.sell) ?? 0,
          strongSell: rawNum(latestRec.strongSell) ?? 0,
        }
      : null;

    const earningsTrendArr = (r.earningsTrend as Record<string, unknown> | undefined)?.trend;
    const trend = Array.isArray(earningsTrendArr) ? earningsTrendArr : [];

    return {
      priceTargetLow: rawNum(fin?.targetLowPrice),
      priceTargetMean: rawNum(fin?.targetMeanPrice),
      priceTargetHigh: rawNum(fin?.targetHighPrice),
      numberOfAnalysts: rawNum(fin?.numberOfAnalystOpinions),
      recommendationMean: rawNum(fin?.recommendationMean),
      recommendationKey: str(fin?.recommendationKey),
      recommendation,
      earningsGrowth: extractGrowth(trend, 'earningsEstimate'),
      revenueGrowth: extractGrowth(trend, 'revenueEstimate'),
    };
  }
}
