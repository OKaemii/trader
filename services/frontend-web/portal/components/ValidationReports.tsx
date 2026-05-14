'use client'
import { useCallback, useEffect, useState } from 'react'

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
  run_at: string
}

export function ValidationReports({ refreshKey }: { refreshKey: number }) {
  const [reports, setReports] = useState<Report[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  useEffect(() => { load() }, [load, refreshKey])

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">Recent validation reports</h2>
        <button
          type="button"
          onClick={load}
          className="text-xs text-gray-400 hover:text-gray-200"
        >
          Refresh
        </button>
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
              <th className="py-1 text-center font-normal">Pass</th>
              <th className="py-1 text-right font-normal">OOS SR</th>
              <th className="py-1 text-right font-normal">Mean IC</th>
              <th className="py-1 text-right font-normal">DSR</th>
              <th className="py-1 text-right font-normal">PBO</th>
              <th className="py-1 text-right font-normal">FDR p</th>
              <th className="py-1 text-right font-normal">Trials</th>
              <th className="py-1 text-right font-normal">N</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r, i) => (
              <tr key={i} className="border-b border-gray-800/50">
                <td className="py-1.5 font-mono text-gray-400">{new Date(r.run_at).toLocaleString()}</td>
                <td className="py-1.5 text-gray-300">{r.strategy_id}</td>
                <td className="py-1.5 text-center">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    r.passed ? 'bg-emerald-700 text-white' : 'bg-red-700 text-white'
                  }`}>{r.passed ? 'PASS' : 'FAIL'}</span>
                </td>
                <td className="py-1.5 text-right font-mono text-gray-300">{r.oos_sharpe?.toFixed(3) ?? '—'}</td>
                <td className="py-1.5 text-right font-mono text-gray-300">{r.mean_ic?.toFixed(4) ?? '—'}</td>
                <td className="py-1.5 text-right font-mono text-gray-300">{r.dsr?.toFixed(3) ?? '—'}</td>
                <td className="py-1.5 text-right font-mono text-gray-300">{r.pbo?.toFixed(3) ?? '—'}</td>
                <td className="py-1.5 text-right font-mono text-gray-300">{r.fdr_p?.toFixed(4) ?? '—'}</td>
                <td className="py-1.5 text-right font-mono text-gray-400">{r.n_trials}</td>
                <td className="py-1.5 text-right font-mono text-gray-400">{r.universe_size ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
