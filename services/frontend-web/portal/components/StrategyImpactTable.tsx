'use client'

import { QuantOnly } from './QuantOnly'

// Per-strategy attribution for one symbol (Research → Strategy Impact, plan §E / Task 26).
// One row per strategy that has ranked OR traded this ticker. Shape mirrors signal-service's
// StrategyImpactRow (GET /admin/api/signals/strategy-impact?ticker=) — kept as a local mirror so
// no service-internal type leaks into the client graph (portal AGENTS.md "Don't import …").
//
// T12 gotchas honoured here:
//   • currentRank === null  → "not yet ranked" (a ticker with signals but no held_set_snapshots
//     yet); render literally, never as rank 0.
//   • selected is the LATEST snapshot only; historicalInclusionPct is the lifetime fraction — they
//     can legitimately disagree (a recently-dropped name: selected=false, inclusion>0). Kept as
//     separate columns so the operator sees both.
//   • contributionPct is a REALISED round-trip fraction (closed BUYs only; open positions add 0) —
//     multiply by 100 for a percent.
export interface StrategyImpactRow {
  strategyId: string
  currentRank: number | null
  historicalInclusionPct: number
  avgHoldingDays: number
  contributionPct: number
  selected: boolean
}

const pct = (frac: number) => `${(frac * 100).toFixed(1)}%`
// Realised round-trip return — sign-coloured + explicitly signed so a loser reads as a loser.
const signedPct = (frac: number) => `${frac >= 0 ? '+' : ''}${(frac * 100).toFixed(1)}%`

export function StrategyImpactTable({ symbol, rows }: { symbol: string; rows: StrategyImpactRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-gray-800 bg-gray-900/40 p-6 text-sm text-gray-400">
        No strategy has ranked or traded{' '}
        <span className="font-mono text-gray-300">{symbol}</span> yet. Once a strategy includes it in
        a held-set snapshot or closes a round-trip, its impact appears here.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-400">
        How each strategy has ranked and traded{' '}
        <span className="font-mono text-gray-300">{symbol}</span>. <span className="font-semibold text-gray-300">Selected</span>{' '}
        is the latest snapshot; <span className="font-semibold text-gray-300">Inclusion</span> is the
        lifetime share of snapshots that held it — the two can differ for a recently-dropped name.
      </p>
      <div className="overflow-x-auto rounded border border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-left text-xs uppercase text-gray-400">
            <tr>
              <th className="px-3 py-2">Strategy</th>
              <th className="px-3 py-2">Rank</th>
              <th className="px-3 py-2">Selected</th>
              {/* Advanced attribution — quant-only. No safety surface here, so curating it away in
                  beginner mode is purely a density choice (portal AGENTS.md). */}
              <QuantOnly>
                <th className="px-3 py-2">Inclusion</th>
                <th className="px-3 py-2">Avg hold</th>
                <th className="px-3 py-2">Contribution</th>
              </QuantOnly>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800 bg-gray-950">
            {rows.map((r) => (
              <tr key={r.strategyId}>
                <td className="px-3 py-2 font-mono text-gray-100">{r.strategyId}</td>
                <td className="px-3 py-2 text-gray-300">
                  {r.currentRank === null ? (
                    <span className="text-gray-500">not yet ranked</span>
                  ) : (
                    `#${r.currentRank}`
                  )}
                </td>
                <td className="px-3 py-2">
                  {r.selected ? (
                    <span className="font-semibold text-emerald-400">Yes</span>
                  ) : (
                    <span className="text-gray-500">No</span>
                  )}
                </td>
                <QuantOnly>
                  <td className="px-3 py-2 text-gray-300">{pct(r.historicalInclusionPct)}</td>
                  <td className="px-3 py-2 text-gray-300">{r.avgHoldingDays.toFixed(1)}d</td>
                  <td
                    className={`px-3 py-2 font-medium ${
                      r.contributionPct > 0
                        ? 'text-emerald-400'
                        : r.contributionPct < 0
                          ? 'text-red-400'
                          : 'text-gray-500'
                    }`}
                  >
                    {signedPct(r.contributionPct)}
                  </td>
                </QuantOnly>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
