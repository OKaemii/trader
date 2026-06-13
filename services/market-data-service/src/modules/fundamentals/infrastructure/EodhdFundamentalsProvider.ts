import type { FundamentalsProvider, FundamentalsRaw } from './FundamentalsProvider.ts';
import { log } from '../../../logger.ts';

// DORMANT. EODHD fundamentals are a paid add-on not on the current plan, so this is wired but
// not active (FUNDAMENTALS_PROVIDER defaults to 'pit'). When the add-on is enabled, parse the
// /fundamentals/{SYMBOL.EX} payload here (annual figures, for ROE = annual net income / equity):
//   netIncome          <- Financials.Income_Statement.yearly[latest].netIncome
//   totalEquity        <- Financials.Balance_Sheet.yearly[latest].totalStockholderEquity
//   totalDebt          <- Financials.Balance_Sheet.yearly[latest].shortLongTermDebtTotal (or netDebt)
//   currentAssets      <- Financials.Balance_Sheet.yearly[latest].totalCurrentAssets
//   currentLiabilities <- Financials.Balance_Sheet.yearly[latest].totalCurrentLiabilities
//   marketCapGbp       <- Highlights.MarketCapitalization, FX-normalised from General.CurrencyCode
// Until then it returns {} — every name then fails the fail-closed QMJ screen (never a false PASS).
export class EodhdFundamentalsProvider implements FundamentalsProvider {
  async fetch(tickers: string[]): Promise<Record<string, FundamentalsRaw>> {
    if (tickers.length > 0) {
      log.warn('[fundamentals/eodhd] EODHD fundamentals add-on not enabled — returning no data (use FUNDAMENTALS_PROVIDER=pit)');
    }
    return {};
  }
}
