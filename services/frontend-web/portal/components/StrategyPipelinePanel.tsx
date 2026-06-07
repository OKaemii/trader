'use client'

import { useEffect, useMemo, useState } from 'react'
import { PipelineFunnel, type PipelineStage } from '@/components/PipelineFunnel'
import { QuantOnly } from '@/components/QuantOnly'

// Strategy-Lab pipeline funnel panel (Build → Strategy, plan §G / Task 37).
//
// SSR-seed + client-poll (the portal no-flicker pattern): StrategyTab fetches the pipeline once on
// the server and hands it in as `initial`; this client component renders the PipelineFunnel, polls
// /portal-api/admin/strategy/<id>/pipeline every 15s for fresh live counts, and drills into a stage
// on click. The funnel VISIBLY NARROWS (Universe → filter(s) → Factor scoring → Top-K → Rebalance)
// because each node's cross-section ∝ its count. Advanced per-stage diagnostics live under
// <QuantOnly> so beginner mode stays uncluttered (safety controls are elsewhere + never gated).

export interface PipelineData {
  strategy_id: string
  /** The strategy the live engine is actually running — may differ from strategy_id if requested for another. */
  active: string
  stages: PipelineStage[]
}

// Plain-English "what this stage does" for the drill-in, keyed by the stable stage key the funnel
// hands back through onStage. Unknown keys fall back to a generic line, so a new backend stage still
// drills in sensibly before it gets a bespoke description here.
const STAGE_HELP: Record<string, string> = {
  universe: 'The candidate universe — every ticker that arrived on the market-data stream this cycle, before any filtering.',
  history: 'Names with enough persisted history (≥ the strategy’s rolling window) to compute factors. Names still warming up are dropped here.',
  qmj: 'The QMJ screen: market cap ≥ the floor AND fail-closed quality (ROE ≥ 0.10 ∧ Debt/Equity ≤ 2.0 ∧ Current ratio ≥ 1.0). Missing data fails closed.',
  scoring: 'Names that received a usable cross-sectional factor score. Ranking sorts these; it doesn’t drop any, so the count is unchanged by ranking.',
  rank: 'The 12-1 momentum ranking over the screened survivors — the top-N momentum names carried into the held-set selection.',
  topk: 'The Top-K held band — the optimiser/selection trims the scored set to the strategy’s configured held-position count.',
  rebalance: 'The held set actually emitted this cycle. Zero on a HOLD cycle (e.g. a monthly strategy between rebalances).',
}

export function StrategyPipelinePanel({ initial }: { initial: PipelineData }) {
  const [data, setData] = useState<PipelineData>(initial)
  const [selected, setSelected] = useState<string | null>(null)

  // The funnel reflects the LIVE engine, which runs one strategy at a time — poll the active id so
  // the counts track the running strategy even if the operator switches it from the selector above.
  const pollId = data.active || data.strategy_id

  useEffect(() => {
    const tick = async () => {
      try {
        const r = await fetch(`/portal-api/admin/strategy/${encodeURIComponent(pollId)}/pipeline`, {
          cache: 'no-store',
        })
        if (r.ok) setData(await r.json())
      } catch {
        // transient fetch failures shouldn't blank the funnel — keep the last good counts
      }
    }
    const id = setInterval(tick, 15_000)
    return () => clearInterval(id)
  }, [pollId])

  const stages = useMemo(() => data.stages ?? [], [data.stages])
  const selectedStage = useMemo(
    () => stages.find((s) => s.key === selected) ?? null,
    [stages, selected],
  )

  // A funnel that hasn't run a cycle yet returns its labelled stages all at 0 — surface that
  // honestly rather than pretending there's no pipeline.
  const noCycleYet = stages.length > 0 && stages.every((s) => s.count === 0)

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-200">Pipeline funnel</h3>
        <span className="font-mono text-xs text-gray-500">{data.active || data.strategy_id}</span>
      </div>

      <p className="text-xs text-gray-500">
        How the candidate universe is winnowed to the held set this cycle. Click a stage for detail.
      </p>

      <PipelineFunnel stages={stages} onStage={(key) => setSelected((k) => (k === key ? null : key))} />

      {noCycleYet && (
        <p className="text-xs text-amber-300">
          No cycle has run yet — counts are zero until the engine emits its first cycle.
        </p>
      )}

      {selectedStage && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-baseline justify-between">
            <h4 className="text-sm font-semibold text-gray-100">{selectedStage.label}</h4>
            <span className="font-mono text-sm tabular-nums text-emerald-400">{selectedStage.count}</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-gray-400">
            {STAGE_HELP[selectedStage.key] ?? 'This stage’s live count at the current cycle.'}
          </p>
        </div>
      )}

      {/* Advanced: the raw per-stage counts table. Quant-only — the funnel itself is enough for
          beginners; the tabular breakdown is a diagnostic. Safety controls are never gated here. */}
      <QuantOnly>
        <details className="rounded-lg border border-gray-800 bg-gray-950 p-3 text-xs">
          <summary className="cursor-pointer text-gray-400">Stage counts (diagnostics)</summary>
          <table className="mt-3 w-full text-left">
            <thead>
              <tr className="text-gray-500">
                <th className="pb-1 font-normal">Stage</th>
                <th className="pb-1 font-normal">Key</th>
                <th className="pb-1 text-right font-normal">Count</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {stages.map((s) => (
                <tr key={s.key} className="border-t border-gray-800/60">
                  <td className="py-1 text-gray-300">{s.label}</td>
                  <td className="py-1 text-gray-500">{s.key}</td>
                  <td className="py-1 text-right text-emerald-400">{s.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </QuantOnly>
    </section>
  )
}
