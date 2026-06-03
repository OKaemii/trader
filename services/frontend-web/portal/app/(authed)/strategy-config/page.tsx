import { authedFetch } from '@/app/lib/auth-fetch'
import { StrategyConfigEditor, type StrategyConfig } from './StrategyConfigEditor'
import { ActiveStrategySelector } from './ActiveStrategySelector'

// SSR-seed the per-strategy tunable surface, then hand to the client editor (SSR-seed +
// client-mutate, the portal's no-flicker pattern). Reads strategy-engine /admin/api/strategy/config.
export default async function StrategyConfigPage() {
  const r = await authedFetch('/admin/api/strategy/config')
  if (!r.ok) {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-bold text-white">Strategy Config</h1>
        <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          {r.status === 401 || r.status === 403 ? 'Admin role required.' : `Failed to load (${r.status}).`}
        </div>
      </div>
    )
  }
  const data = (await r.json().catch(() => ({ strategies: [], active: '' }))) as {
    strategies: StrategyConfig[]
    active: string
  }

  return (
    <div className="space-y-6 p-6">
      <ActiveStrategySelector strategies={(data.strategies ?? []).map((s) => s.strategy_id)} active={data.active ?? ''} />
      <StrategyConfigEditor initial={data.strategies ?? []} active={data.active ?? ''} />
    </div>
  )
}
