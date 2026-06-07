import { ScaffoldBody } from './ScaffoldBody'

// Signals tab — per-symbol signals question-tab (research-trading-os Task 23 shell).
//
// SCAFFOLD: Task 25 fills this body with the per-symbol signal list (GET
// /admin/api/signals/by-ticker/:ticker) + a WhyPanel per signal (gate booleans derived from
// the factor store as-of the signal ts + signal context). Distinct from the cross-sectional
// MarketSignalsTab (the whole-market feed the no-symbol landing renders for the /signals stub).
//
// PROP CONTRACT: async server component taking exactly `{ symbol }` (see OverviewTab) — the
// in-universe ticker, guaranteed non-empty by page.tsx.
export async function SignalsTab({ symbol }: { symbol: string }) {
  return (
    <ScaffoldBody tab="Signals" symbol={symbol}>
      Per-symbol signal history with a Why? panel (factor gates as-of each signal) renders here.
    </ScaffoldBody>
  )
}
