'use client'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { Explain } from '@/components/Explain'

interface Report {
  strategy_id: string
  passed: boolean
  failures: string[]
  oos_sharpe: number
  mean_ic: number
  dsr: number
  pbo: number
  fdr_p: number
  n_trials: number
  universe_size?: number
  engine?: string                                 // 'replay' | 'synthetic'
  benchmark?: { beats_market?: boolean } | null   // BenchmarkComparison subset
  mcpt_in_sample_quasi_p?: number | null
  mcpt_walk_forward_quasi_p?: number | null
  ai_explanation?: { text: string; model?: string; generated_at?: string }
  run_at: string
}

// Plain-English gloss for each metric column — the "what does this number mean" the report
// table never had. Shown in the expandable row alongside the LLM write-up.
const METRIC_LEGEND: Array<[string, string]> = [
  ['OOS Sharpe', 'Risk-adjusted return on out-of-sample data (higher is better; >1 is good).'],
  ['Mean IC', 'Information coefficient — correlation between the signal and forward returns (>0 means predictive).'],
  ['DSR', 'Deflated Sharpe — the Sharpe after penalising for the number of trials (guards against luck).'],
  ['PBO', 'Probability of backtest overfitting (0–1). Below 0.5 is good; high means the edge likely won’t survive live.'],
  ['FDR p', 'False-discovery-rate-corrected p-value across the strategy battery (<0.10 to pass).'],
  ['MCPT p', 'Permutation-test p-values (in-sample & walk-forward): the chance the result is luck. <0.05 is good.'],
]

interface ValidationReportsProps {
  refreshKey: number
  initial?: Report[] | null
}

export function ValidationReports({ refreshKey, initial = null }: ValidationReportsProps) {
  const [reports, setReports] = useState<Report[]>(initial ?? [])
  const [loading, setLoading] = useState(initial === null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [explaining, setExplaining] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    fetch('/portal-api/admin/backtest/results?limit=10')
      .then(async (r) => {
        const d = await r.json()
        if (!r.ok) throw new Error(`status ${r.status}`)
        setReports(d.results ?? [])
        setError(null)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // Backfill DeepSeek explanations for any reports missing one, then reload to show them.
  const explainAll = useCallback(async () => {
    setExplaining(true)
    try {
      const r = await fetch('/portal-api/admin/backtest/explain?limit=10', { method: 'POST' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(`status ${r.status}`)
      if (d.available === false) setError('DeepSeek not configured on backtest-engine (DEEPSEEK_API_KEY).')
      load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setExplaining(false) }
  }, [load])

  // Skip the initial load when SSR seeded us. Subsequent refreshKey bumps from the
  // backtest runner still trigger refetches.
  useEffect(() => {
    if (initial !== null && refreshKey === 0) return
    load()
  }, [load, refreshKey, initial])

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">Recent validation reports <span className="ml-1 text-xs font-normal text-gray-500">— click a row for a plain-English read</span></h2>
        <div className="flex items-center gap-3">
          <button type="button" onClick={explainAll} disabled={explaining}
            className="rounded bg-gray-800 px-2 py-1 text-xs text-gray-200 hover:bg-gray-700 disabled:opacity-50">
            {explaining ? 'Explaining…' : '✨ Explain with AI'}
          </button>
          <button type="button" onClick={load} className="text-xs text-gray-400 hover:text-gray-200">Refresh</button>
        </div>
      </div>
      {loading && reports.length === 0 ? (
        <div className="h-24 animate-pulse rounded bg-gray-800" />
      ) : error ? (
        <p className="text-xs text-red-400">{error}</p>
      ) : reports.length === 0 ? (
        <p className="text-xs text-gray-500">No prior backtests on record.</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-gray-500">
            <tr className="border-b border-gray-800">
              <th className="py-1 text-left font-normal">When</th>
              <th className="py-1 text-left font-normal">Strategy</th>
              <th className="py-1 text-center font-normal">Engine</th>
              <th className="py-1 text-center font-normal">Pass</th>
              <th className="py-1 text-center font-normal">Bench</th>
              <th className="py-1 text-right font-normal">OOS SR</th>
              <th className="py-1 text-right font-normal">Mean IC</th>
              <th className="py-1 text-right font-normal">
                <span className="inline-flex items-center justify-end gap-1">DSR <Explain id="dsr" /></span>
              </th>
              <th className="py-1 text-right font-normal">
                <span className="inline-flex items-center justify-end gap-1">PBO <Explain id="pbo" /></span>
              </th>
              <th className="py-1 text-right font-normal">FDR p</th>
              <th className="py-1 text-right font-normal">Trials</th>
              <th className="py-1 text-right font-normal">N</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r, i) => (
              <Fragment key={i}>
                <tr onClick={() => setExpanded(expanded === i ? null : i)}
                  className={`cursor-pointer border-b border-gray-800/50 hover:bg-gray-800/40 ${expanded === i ? 'bg-gray-800/40' : ''}`}>
                  <td className="py-1.5 font-mono text-gray-400">
                    <span className="mr-1 text-gray-600">{expanded === i ? '▾' : '▸'}</span>
                    {new Date(r.run_at).toLocaleString()}
                    {r.ai_explanation && <span className="ml-1" title="AI explanation available">✨</span>}
                  </td>
                  <td className="py-1.5 text-gray-300">{r.strategy_id}</td>
                  <td className="py-1.5 text-center">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                      r.engine === 'synthetic' ? 'bg-red-800 text-red-100' : 'bg-gray-700 text-gray-200'
                    }`}>{r.engine ?? 'replay'}</span>
                  </td>
                  <td className="py-1.5 text-center">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      r.passed ? 'bg-emerald-700 text-white' : 'bg-red-700 text-white'
                    }`}>{r.passed ? 'PASS' : 'FAIL'}</span>
                  </td>
                  <td className="py-1.5 text-center font-mono">
                    {r.benchmark
                      ? <span className={r.benchmark.beats_market ? 'text-emerald-400' : 'text-amber-300'}>
                          {r.benchmark.beats_market ? '✓' : '✗'}
                        </span>
                      : <span className="text-gray-600">—</span>}
                  </td>
                  <td className="py-1.5 text-right font-mono text-gray-300">{r.oos_sharpe?.toFixed(3) ?? '—'}</td>
                  <td className="py-1.5 text-right font-mono text-gray-300">{r.mean_ic?.toFixed(4) ?? '—'}</td>
                  <td className="py-1.5 text-right font-mono text-gray-300">{r.dsr?.toFixed(3) ?? '—'}</td>
                  <td className="py-1.5 text-right font-mono text-gray-300">{r.pbo?.toFixed(3) ?? '—'}</td>
                  <td className="py-1.5 text-right font-mono text-gray-300">{r.fdr_p?.toFixed(4) ?? '—'}</td>
                  <td className="py-1.5 text-right font-mono text-gray-400">{r.n_trials}</td>
                  <td className="py-1.5 text-right font-mono text-gray-400">{r.universe_size ?? '—'}</td>
                </tr>
                {expanded === i && (
                  <tr className="border-b border-gray-800 bg-gray-950/60">
                    <td colSpan={12} className="px-3 py-3">
                      {r.failures && r.failures.length > 0 && (
                        <div className="mb-2 text-xs text-red-300">Failed gates: {r.failures.join(', ')}</div>
                      )}
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">What this means</div>
                          {r.ai_explanation
                            ? <p className="whitespace-pre-line text-xs leading-relaxed text-gray-300">{r.ai_explanation.text}</p>
                            : <p className="text-xs text-gray-500">No AI explanation yet — click <span className="text-gray-300">✨ Explain with AI</span> above to generate one (cached after).</p>}
                          {r.ai_explanation?.model && (
                            <p className="mt-1 text-[10px] text-gray-600">via {r.ai_explanation.model}</p>
                          )}
                        </div>
                        <div>
                          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Metric guide</div>
                          <dl className="space-y-1 text-[11px]">
                            {METRIC_LEGEND.map(([k, v]) => (
                              <div key={k}>
                                <dt className="inline font-mono text-gray-300">{k}</dt>
                                <dd className="inline text-gray-500"> — {v}</dd>
                              </div>
                            ))}
                            <div>
                              <dt className="inline font-mono text-gray-300">MCPT p</dt>
                              <dd className="inline text-gray-500"> — in-sample {r.mcpt_in_sample_quasi_p ?? '—'}, walk-forward {r.mcpt_walk_forward_quasi_p ?? '—'}.</dd>
                            </div>
                          </dl>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
