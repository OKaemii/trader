import { ScaffoldBody } from './ScaffoldBody'

// Strategy Impact tab — per-symbol strategy attribution (research-trading-os Task 23 shell).
//
// SCAFFOLD: Task 26 fills this body with the per-strategy impact table (GET
// /admin/api/signals/strategy-impact?ticker=) — how each strategy has traded / would trade
// this symbol, and its contribution.
//
// PROP CONTRACT: async server component taking exactly `{ symbol }` (see OverviewTab).
export async function StrategyImpactTab({ symbol }: { symbol: string }) {
  return (
    <ScaffoldBody tab="Strategy Impact" symbol={symbol}>
      Per-strategy impact table (how each strategy trades this symbol) renders here.
    </ScaffoldBody>
  )
}
