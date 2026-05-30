'use client'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import type { McptStep } from './validation-types'
import { quasiPLabel } from './validation-types'

// Bucket the permutation objectives into a histogram on a numeric x-axis so the real-objective
// ReferenceLine aligns exactly — and so a real value that beats *every* permutation (the
// strongest signal) still renders on-chart, far to the right of the null mass.
function buildBins(values: number[], real: number, nbins = 24) {
  if (values.length === 0) return { bins: [] as { centre: number; count: number }[], domain: [real - 1, real + 1] as [number, number] }
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = (hi - lo) || Math.abs(hi) || 1
  const w = span / nbins
  const bins = Array.from({ length: nbins }, (_, i) => ({ centre: lo + (i + 0.5) * w, count: 0 }))
  for (const v of values) {
    let idx = Math.floor((v - lo) / w)
    idx = Math.max(0, Math.min(nbins - 1, idx))
    bins[idx].count++
  }
  const pad = span * 0.05
  const domain: [number, number] = [Math.min(lo, real) - pad, Math.max(hi, real) + pad]
  return { bins, domain }
}

export function MCPTHistogramPanel({
  step, title, objectiveName,
}: { step: McptStep; title: string; objectiveName: string }) {
  const { bins, domain } = buildBins(step.permutation_objectives ?? [], step.real_objective)
  return (
    <section className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-gray-300">{title}</h3>
        <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
          step.passed ? 'bg-emerald-700 text-white' : 'bg-red-700 text-white'
        }`}>
          {step.passed ? 'PASS' : 'FAIL'} · quasi-p {quasiPLabel(step)} (&lt; {step.threshold})
        </span>
      </div>
      <p className="mt-1 text-[11px] text-gray-500">
        {step.n_permutations} permutations · objective = {objectiveName} · amber = observed ({step.real_objective.toFixed(3)})
      </p>
      <div className="mt-3 h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bins} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <XAxis
              type="number" dataKey="centre" domain={domain} tick={{ fill: '#9ca3af', fontSize: 9 }}
              tickFormatter={(v) => Number(v).toFixed(2)}
            />
            <YAxis tick={{ fill: '#9ca3af', fontSize: 9 }} allowDecimals={false} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: 'none', color: '#fff' }}
              formatter={(v) => [v as number, 'permutations']}
              labelFormatter={(l) => `objective ≈ ${Number(l).toFixed(3)}`}
            />
            <Bar dataKey="count" fill="#4f46e5" isAnimationActive={false} />
            <ReferenceLine x={step.real_objective} stroke="#f59e0b" strokeWidth={2} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}
