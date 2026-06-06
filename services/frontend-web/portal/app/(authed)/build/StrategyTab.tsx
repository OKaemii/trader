import { authedFetch } from '@/app/lib/auth-fetch'
import { StrategyConfigEditor, type StrategyConfig } from '@/components/StrategyConfigEditor'
import { ActiveStrategySelector } from '@/components/ActiveStrategySelector'

// Strategy tab (Build workspace, IA-redesign Task 9) — the body of the old /strategy-config page
// verbatim: SSR-seed the per-strategy tunable surface from strategy-engine
// /admin/api/strategy/config, then hand to the client editor (SSR-seed + client-mutate, the
// portal's no-flicker pattern). Rendered only when this tab is active, so this is the only
// authedFetch that runs for the tab.
export async function StrategyTab() {
  const r = await authedFetch('/admin/api/strategy/config')
  if (!r.ok) {
    return (
      <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
        {r.status === 401 || r.status === 403 ? 'Admin role required.' : `Failed to load (${r.status}).`}
      </div>
    )
  }
  const data = (await r.json().catch(() => ({ strategies: [], active: '' }))) as {
    strategies: StrategyConfig[]
    active: string
  }

  return (
    <div className="space-y-6">
      <ActiveStrategySelector strategies={(data.strategies ?? []).map((s) => s.strategy_id)} active={data.active ?? ''} />
      <StrategyConfigEditor initial={data.strategies ?? []} active={data.active ?? ''} />
    </div>
  )
}
