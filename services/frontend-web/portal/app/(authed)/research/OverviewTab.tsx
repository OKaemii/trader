import { ScaffoldBody } from './ScaffoldBody'

// Overview tab — the symbol-workspace landing question-tab (research-trading-os Task 23 shell).
//
// SCAFFOLD: Task 24 fills this body with the real Overview — CandlestickChart (reused),
// FactorBars (factor percentile bars from the strategy scores store), per-symbol active
// signals, strategy exposure, and Recent Events (news). The shell (research/page.tsx)
// already renders SymbolHeader above this, so the tab body starts below the identity strip.
//
// PROP CONTRACT (stable; downstream cards extend the body, not the signature): every Research
// question-tab is an async server component taking exactly `{ symbol }` — the in-universe
// ticker (e.g. 'AAPL_US_EQ'). page.tsx guarantees `symbol` is non-empty before mounting a tab
// (no symbol → the landing renders instead), so a tab never has to handle an absent symbol.
export async function OverviewTab({ symbol }: { symbol: string }) {
  return (
    <ScaffoldBody tab="Overview" symbol={symbol}>
      Chart, factor percentile bars, active signals, strategy exposure, and recent events for{' '}
      <span className="font-mono text-gray-300">{symbol}</span> render here.
    </ScaffoldBody>
  )
}
