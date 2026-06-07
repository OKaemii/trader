import { authedFetch } from '@/app/lib/auth-fetch'
import { StrategyImpactTable, type StrategyImpactRow } from '@/components/StrategyImpactTable'

// Strategy Impact tab — per-symbol strategy attribution (research-trading-os Task 26 / plan §E).
//
// SSR-seeds the per-strategy impact table from signal-service's
// GET /admin/api/signals/strategy-impact?ticker= (mounted by Task 12). A server component can't
// fetch its own /portal-api/* proxy, so it calls authedFetch on the upstream path directly — the
// proxy (app/portal-api/admin/signals/strategy-impact/route.ts) exists for any future client poll.
//
// PROP CONTRACT (Task 23 shell — extend the body, not the signature): async server component taking
// exactly `{ symbol }` (the in-universe ticker, e.g. 'AAPL_US_EQ'). page.tsx guarantees `symbol` is
// a non-empty string before mounting a tab, so this never handles an absent symbol.
export async function StrategyImpactTab({ symbol }: { symbol: string }) {
  let rows: StrategyImpactRow[] = []
  try {
    const r = await authedFetch(`/admin/api/signals/strategy-impact?ticker=${encodeURIComponent(symbol)}`)
    if (r.ok) {
      const body = (await r.json()) as { strategies?: StrategyImpactRow[] }
      rows = body.strategies ?? []
    }
  } catch {
    // Degrade to the honest empty state below rather than crashing the tab — a transient upstream
    // failure shouldn't take down the whole Research workspace render.
    rows = []
  }

  return <StrategyImpactTable symbol={symbol} rows={rows} />
}
