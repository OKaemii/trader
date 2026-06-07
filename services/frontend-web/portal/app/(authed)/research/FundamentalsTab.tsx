import { ScaffoldBody } from './ScaffoldBody'

// Fundamentals tab — per-symbol financials (research-trading-os Task 23 shell).
//
// SCAFFOLD: Task 27 fills this body with grouped financials from company_fundamentals (Yahoo):
// Valuation / Profitability / Growth / Balance Sheet, dividend yield + history (EODHD
// Dividends), and Analyst Estimates (Yahoo quoteSummary).
//
// PROP CONTRACT: async server component taking exactly `{ symbol }` (see OverviewTab).
export async function FundamentalsTab({ symbol }: { symbol: string }) {
  return (
    <ScaffoldBody tab="Fundamentals" symbol={symbol}>
      Grouped financials (valuation, profitability, growth, balance sheet), dividends, and
      analyst estimates render here.
    </ScaffoldBody>
  )
}
