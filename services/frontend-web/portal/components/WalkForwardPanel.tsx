'use client'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { Step3WalkForward, BenchmarkOverlay } from './validation-types'
import { pct } from './validation-types'

export function WalkForwardPanel({
  step, overlays, objectiveName,
}: { step: Step3WalkForward; overlays: BenchmarkOverlay[]; objectiveName: string }) {
  const equity = (step.oos_equity ?? []).map((v, i) => ({ i, equity: v }))
  return (
    <section className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-gray-300">Walk-forward (out-of-sample)</h3>
        <span className="text-[11px] text-gray-500">
          {step.folds?.length ?? 0} folds · {step.oos_periods} periods · {step.embargo_days}d embargo · {objectiveName} = {step.oos_objective?.toFixed(3)}
        </span>
      </div>
      <div className="mt-3 h-40">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={equity} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <XAxis dataKey="i" tick={{ fill: '#9ca3af', fontSize: 9 }} />
            <YAxis tick={{ fill: '#9ca3af', fontSize: 9 }} tickFormatter={(v) => Number(v).toFixed(2)} domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: 'none', color: '#fff' }}
              formatter={(v) => [(v as number).toFixed(3), 'OOS equity']}
              labelFormatter={(l) => `period ${l}`}
            />
            <Line type="monotone" dataKey="equity" stroke="#60a5fa" dot={false} strokeWidth={1.5} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {overlays.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Benchmark overlay (OOS, after costs)</div>
          <table className="mt-1 w-full text-[11px]">
            <thead className="text-gray-500">
              <tr className="border-b border-gray-800">
                <th className="py-1 text-left font-normal">Bench</th>
                <th className="py-1 text-center font-normal">Beats</th>
                <th className="py-1 text-right font-normal">Strat</th>
                <th className="py-1 text-right font-normal">Bench</th>
                <th className="py-1 text-right font-normal">Excess</th>
                <th className="py-1 text-right font-normal">α ann</th>
                <th className="py-1 text-right font-normal">β</th>
                <th className="py-1 text-right font-normal">IR</th>
              </tr>
            </thead>
            <tbody>
              {overlays.map((o) => (
                <tr key={o.benchmark} className="border-b border-gray-800/50 font-mono text-gray-300">
                  <td className="py-1 font-sans text-gray-200">{o.benchmark}</td>
                  <td className="py-1 text-center">
                    {o.beats_market ? <span className="text-emerald-400">✓</span> : <span className="text-amber-300">✗</span>}
                  </td>
                  <td className="py-1 text-right">{pct(o.strategy_total_return)}</td>
                  <td className="py-1 text-right">{pct(o.benchmark_total_return)}</td>
                  <td className={`py-1 text-right ${o.excess_total_return >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pct(o.excess_total_return)}</td>
                  <td className="py-1 text-right">{pct(o.alpha_annual)}</td>
                  <td className="py-1 text-right">{o.beta.toFixed(2)}</td>
                  <td className="py-1 text-right">{o.information_ratio.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
