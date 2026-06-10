// Yahoo quoteSummary fundamentals — the default (free) QMJ data source, since EODHD fundamentals
// are a paid add-on not on the current plan. Pulls the raw line items the quality screen needs
// and FX-normalises market cap to GBP. The three ratios are computed downstream (qmj.ts /
// quant-core quality.py), not here, so the thresholds live in one canonical place.

import { setTimeout as sleep } from 'node:timers/promises';
import type { Currency } from '@trader/shared-types';
import type { FundamentalsProvider, FundamentalsRaw, FxToGBP } from './FundamentalsProvider.ts';
import { YahooQuoteSummary, type QuoteSummaryFetcher } from '../../bars/infrastructure/providers/yahoo-quote-summary.ts';
import { toYahooSymbol, isBlacklisted } from '../../bars/infrastructure/providers/yahoo-client.ts';
import { log } from '../../../logger.ts';

// Annual modules: incomeStatementHistory + balanceSheetHistory are the latest fiscal YEAR
// (correct for ROE = annual net income / equity, not a single quarter); price/summaryDetail
// carry market cap + currency.
const MODULES = ['incomeStatementHistory', 'balanceSheetHistory', 'financialData', 'price', 'summaryDetail'];

// Yahoo wraps numbers as { raw, fmt }. Accept the wrapped form or a bare number.
function rawNum(node: unknown): number | undefined {
  if (typeof node === 'number') return Number.isFinite(node) ? node : undefined;
  if (node && typeof node === 'object' && 'raw' in (node as Record<string, unknown>)) {
    const r = (node as { raw?: unknown }).raw;
    return typeof r === 'number' && Number.isFinite(r) ? r : undefined;
  }
  return undefined;
}

function firstOf(node: unknown, key: string): Record<string, unknown> | undefined {
  const arr = (node as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(arr) ? (arr[0] as Record<string, unknown> | undefined) : undefined;
}

export class YahooFundamentalsProvider implements FundamentalsProvider {
  constructor(
    private readonly fxToGBP: FxToGBP,
    private readonly qs: QuoteSummaryFetcher = new YahooQuoteSummary(),
    private readonly interRequestMs = 200,
  ) {}

  async fetch(tickers: string[]): Promise<Record<string, FundamentalsRaw>> {
    const out: Record<string, FundamentalsRaw> = {};
    for (const ticker of tickers) {
      try {
        const sym = toYahooSymbol(ticker);
        if (isBlacklisted(sym)) continue;
        const result = await this.qs.fetchModules(sym, MODULES);
        if (!result) continue;                            // 404 / unknown — omit
        out[ticker] = await this.extract(result);
      } catch (err) {
        log.warn(`[fundamentals/yahoo] ${ticker}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.interRequestMs > 0) await sleep(this.interRequestMs);
    }
    return out;
  }

  private async extract(r: Record<string, unknown>): Promise<FundamentalsRaw> {
    const income  = firstOf(r.incomeStatementHistory, 'incomeStatementHistory');
    const balance = firstOf(r.balanceSheetHistory, 'balanceSheetStatements');
    const fin     = r.financialData as Record<string, unknown> | undefined;
    const price   = r.price as Record<string, unknown> | undefined;
    const summary = r.summaryDetail as Record<string, unknown> | undefined;

    const netIncome          = rawNum(income?.netIncome) ?? 0;
    const totalEquity        = rawNum(balance?.totalStockholderEquity) ?? 0;
    const totalDebt          = rawNum(fin?.totalDebt)
      ?? ((rawNum(balance?.shortLongTermDebt) ?? 0) + (rawNum(balance?.longTermDebt) ?? 0));
    const currentAssets      = rawNum(balance?.totalCurrentAssets) ?? 0;
    const currentLiabilities = rawNum(balance?.totalCurrentLiabilities) ?? 0;

    const capNative = rawNum(price?.marketCap) ?? rawNum(summary?.marketCap) ?? 0;
    const ccyStr = (typeof price?.currency === 'string' ? price.currency : undefined)
      ?? (typeof summary?.currency === 'string' ? summary.currency : undefined);
    // Market cap is reported in the major currency unit (GBp/GBX quote → cap still GBP).
    const ccy: Currency = ccyStr === 'USD' ? 'USD' : 'GBP';
    // 0 is never a real market cap; an absent quote carries `null` so the scanner / Research render
    // `—` rather than a fabricated £0 (the same null-not-zero contract the PIT provider honours).
    const marketCapGbp = capNative > 0 ? await this.fxToGBP(capNative, ccy) : null;

    return { netIncome, totalEquity, totalDebt, currentAssets, currentLiabilities, marketCapGbp };
  }
}
