'use client'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { Step1Fit } from './validation-types'

export function InSamplePanel({ step, objectiveName }: { step: Step1Fit; objectiveName: string }) {
  const equity = (step.equity ?? []).map((v, i) => ({ i, equity: v }))
  const grid = (step.grid_results ?? []).filter((g) => g.objective !== null)
  const objs = grid.map((g) => g.objective as number)
  const lo = objs.length ? Math.min(...objs) : 0
  const hi = objs.length ? Math.max(...objs) : 1
  const cellClass = (o: number | null) => {
    if (o === null) return 'bg-gray-800 text-gray-600'
    const t = hi > lo ? (o - lo) / (hi - lo) : 1
    return t > 0.66 ? 'bg-emerald-800 text-emerald-100'
      : t > 0.33 ? 'bg-emerald-900/60 text-emerald-200'
      : 'bg-gray-800 text-gray-400'
  }

  return (
    <section className="rounded border border-gray-800 bg-gray-900 p-4">
      <h3 className="text-sm font-medium text-gray-300">In-sample fit</h3>
      <p className="mt-1 text-[11px] text-gray-500">
        best {objectiveName} = {step.objective?.toFixed(3)} ·{' '}
        <span className="font-mono">{JSON.stringify(step.best_params)}</span>
      </p>
      <div className="mt-3 h-40">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={equity} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <XAxis dataKey="i" tick={{ fill: '#9ca3af', fontSize: 9 }} />
            <YAxis tick={{ fill: '#9ca3af', fontSize: 9 }} tickFormatter={(v) => Number(v).toFixed(2)} domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: 'none', color: '#fff' }}
              formatter={(v) => [(v as number).toFixed(3), 'equity (£1→)']}
              labelFormatter={(l) => `period ${l}`}
            />
            <Line type="monotone" dataKey="equity" stroke="#34d399" dot={false} strokeWidth={1.5} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {grid.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Grid search ({grid.length} configs · greener = better)</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {grid.map((g, idx) => (
              <span
                key={idx}
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${cellClass(g.objective)}`}
                title={JSON.stringify(g.params)}
              >
                {(g.objective as number).toFixed(2)}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
