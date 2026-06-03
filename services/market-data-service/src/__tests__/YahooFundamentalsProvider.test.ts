// YahooFundamentalsProvider — line-item extraction + market-cap FX, with the quoteSummary
// session machinery stubbed via the structural QuoteSummaryFetcher.

import { describe, it, expect } from 'vitest';
import { YahooFundamentalsProvider } from '../modules/fundamentals/infrastructure/YahooFundamentalsProvider.ts';

const fx = async (amount: number, ccy: string) => (ccy === 'USD' ? amount * 0.8 : amount);
const qsReturning = (payload: Record<string, unknown> | null) => ({ fetchModules: async () => payload });

describe('YahooFundamentalsProvider', () => {
  it('extracts raw line items and FX-normalises market cap to GBP', async () => {
    const p = new YahooFundamentalsProvider(fx, qsReturning({
      incomeStatementHistory: { incomeStatementHistory: [{ netIncome: { raw: 1000 } }] },
      balanceSheetHistory: { balanceSheetStatements: [{
        totalStockholderEquity: { raw: 5000 },
        totalCurrentAssets:     { raw: 3000 },
        totalCurrentLiabilities: { raw: 1500 },
      }] },
      financialData: { totalDebt: { raw: 3000 } },
      price: { marketCap: { raw: 1e10 }, currency: 'USD' },
    }), 0);
    const out = await p.fetch(['AAPL_US_EQ']);
    expect(out['AAPL_US_EQ']).toEqual({
      netIncome: 1000, totalEquity: 5000, totalDebt: 3000, currentAssets: 3000, currentLiabilities: 1500, marketCapGbp: 8e9,
    });
  });

  it('falls back to balance-sheet debt + summaryDetail cap; defaults missing items to 0', async () => {
    const p = new YahooFundamentalsProvider(fx, qsReturning({
      balanceSheetHistory: { balanceSheetStatements: [{ shortLongTermDebt: { raw: 200 }, longTermDebt: { raw: 800 } }] },
      summaryDetail: { marketCap: { raw: 5e9 }, currency: 'GBp' },
    }), 0);
    const out = await p.fetch(['HSBAl_EQ']);
    expect(out['HSBAl_EQ']!.totalDebt).toBe(1000);     // 200 + 800
    expect(out['HSBAl_EQ']!.marketCapGbp).toBe(5e9);   // GBp cap is the GBP major unit → identity
    expect(out['HSBAl_EQ']!.netIncome).toBe(0);        // missing → 0 (fail-closed)
    expect(out['HSBAl_EQ']!.totalEquity).toBe(0);
  });

  it('omits tickers the provider cannot resolve (fetchModules → null)', async () => {
    const p = new YahooFundamentalsProvider(fx, qsReturning(null), 0);
    expect(await p.fetch(['ZZZZ_US_EQ'])).toEqual({});
  });
});
