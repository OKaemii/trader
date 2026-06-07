'use client'

import { QuantOnly } from './QuantOnly'

// Compact per-strategy exposure table for a symbol (research-trading-os Task 38 §C density +
// Beginner/Quant audit). One row per strategy that has ranked OR traded the ticker, sourced from
// /admin/api/signals/strategy-impact?ticker=. Mirrors the StrategyImpactRow wire shape as a local
// type so no service-internal type leaks into the client graph (portal AGENTS.md "Don't import …").
//
// WHY THIS COMPONENT EXISTS: the Overview tab and the universal drawer each carried their own
// inlined copy of this table that showed the advanced attribution columns (Held %, Avg hold,
// Contribution) UNCONDITIONALLY — while the dedicated Strategy Impact tab (StrategyImpactTable.tsx)
// correctly curates those exact columns behind <QuantOnly>. That divergence meant the same advanced
// attribution appeared in beginner mode on Overview/the drawer but not on the Strategy Impact tab.
// Consolidating into one component makes the Beginner/Quant treatment identical everywhere the
// exposure table renders: the safe baseline — strategy · rank · in-book — stays visible in both
// modes; only the advanced attribution columns are gated.
//
// HONESTY: a null currentRank is "ranked-never" → render "—", never a fabricated rank 0.

/** One per-strategy exposure row (mirror of signal-service StrategyImpactRow). `avgHoldingDays`
 *  is optional because the drawer's lighter fetch omits it; the column hides when no row carries it. */
export interface StrategyExposureRow {
  strategyId: string
  currentRank: number | null
  historicalInclusionPct: number
  avgHoldingDays?: number
  contributionPct: number
  selected: boolean
}

export function StrategyExposureTable({
  rows,
  dense = false,
}: {
  rows: StrategyExposureRow[]
  /** Drawer-tight variant (smaller type + padding) vs the roomier full-route variant. */
  dense?: boolean
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-gray-400">No strategy has ranked or traded this symbol yet.</p>
  }

  // Only show the Avg-hold column when at least one row carries it (the drawer fetch omits it).
  const showAvgHold = rows.some((r) => typeof r.avgHoldingDays === 'number')
  const textSize = dense ? 'text-xs' : 'text-sm'
  const headPad = dense ? 'pb-1 pr-3' : 'pb-2 pr-4'
  const headLast = dense ? 'pb-1' : 'pb-2'
  const cellPad = dense ? 'py-1.5 pr-3' : 'py-2 pr-4'
  const lastPad = dense ? 'py-1.5' : 'py-2'

  return (
    <div className="overflow-x-auto">
      <table className={`w-full text-left ${textSize}`}>
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-gray-500">
            <th className={`${headPad} font-medium`}>Strategy</th>
            <th className={`${headPad} font-medium`}>Rank</th>
            {/* Advanced attribution — quant-only (no safety surface; curating it away in beginner
                mode is a density choice, consistent with StrategyImpactTable). */}
            <QuantOnly>
              <th className={`${headPad} font-medium`}>Held %</th>
              {showAvgHold && <th className={`${headPad} font-medium`}>Avg hold</th>}
              <th className={`${headPad} font-medium`}>Contribution</th>
            </QuantOnly>
            <th className={`${headLast} font-medium`}>In book</th>
          </tr>
        </thead>
        <tbody className="font-mono text-xs tabular-nums text-gray-300">
          {rows.map((r) => (
            <tr key={r.strategyId} className="border-t border-gray-800">
              <td className={`${cellPad} font-sans text-gray-200`}>{r.strategyId}</td>
              {/* currentRank null ⇒ ranked-never; show "—", not a fabricated rank. */}
              <td className={cellPad}>{r.currentRank === null ? '—' : r.currentRank}</td>
              <QuantOnly>
                <td className={cellPad}>{(r.historicalInclusionPct * 100).toFixed(0)}%</td>
                {showAvgHold && (
                  <td className={cellPad}>
                    {typeof r.avgHoldingDays === 'number' && r.avgHoldingDays > 0
                      ? `${r.avgHoldingDays.toFixed(0)}d`
                      : '—'}
                  </td>
                )}
                <td className={`${cellPad} ${r.contributionPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {r.contributionPct >= 0 ? '+' : ''}
                  {(r.contributionPct * 100).toFixed(2)}%
                </td>
              </QuantOnly>
              <td className={lastPad}>
                {r.selected ? (
                  <span className="text-emerald-400">held</span>
                ) : (
                  <span className="text-gray-500">no</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
