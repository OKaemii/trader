import { authedFetch } from '@/app/lib/auth-fetch'
import { StrategyConfigEditor, type StrategyConfig } from '@/components/StrategyConfigEditor'
import { ActiveStrategySelector } from '@/components/ActiveStrategySelector'
import { ForceRebalanceButton } from '@/components/ForceRebalanceButton'
import { StrategyPipelinePanel, type PipelineData } from '@/components/StrategyPipelinePanel'
import { Backlinks } from '@/components/Backlinks'
import { fetchBacklinks } from '@/app/lib/research-notes'

// SSR-seed the Strategy-Lab pipeline funnel for the active strategy (T37 §G). Degrades to empty
// stages on any failure — the funnel renders its own empty-state, and a transient miss here must not
// fail the whole tab. The client panel then polls /portal-api/admin/strategy/<id>/pipeline for live
// counts. Kept out of StrategyTab's render so a pipeline hiccup never blanks the config editor.
async function loadPipeline(active: string): Promise<PipelineData> {
  const empty: PipelineData = { strategy_id: active, active, stages: [] }
  if (!active) return empty
  try {
    const r = await authedFetch(`/admin/api/strategy/${encodeURIComponent(active)}/pipeline`)
    if (!r.ok) return empty
    return (await r.json()) as PipelineData
  } catch {
    return empty
  }
}

// Strategy tab (Build workspace, IA-redesign Task 9) — the body of the old /strategy-config page
// verbatim: SSR-seed the per-strategy tunable surface from strategy-engine
// /admin/api/strategy/config, then hand to the client editor (SSR-seed + client-mutate, the
// portal's no-flicker pattern). T37 adds the Strategy-Lab pipeline funnel below the editor.
// Rendered only when this tab is active, so these authedFetches run only for the tab.
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
  const active = data.active ?? ''
  // Pipeline + the research notes that @-mention the active strategy (T34 §G backlinks) — both
  // best-effort, fetched after the config so a miss in either never blanks the editor.
  const [pipeline, backlinks] = await Promise.all([
    loadPipeline(active),
    active ? fetchBacklinks('strategy', active) : Promise.resolve([]),
  ])

  return (
    <div className="space-y-6">
      <ActiveStrategySelector strategies={(data.strategies ?? []).map((s) => s.strategy_id)} active={active} />
      <ForceRebalanceButton active={active} />
      <StrategyPipelinePanel initial={pipeline} />
      <StrategyConfigEditor initial={data.strategies ?? []} active={active} />
      {active && <Backlinks kind="strategy" ref_={active} initial={backlinks} />}
    </div>
  )
}
