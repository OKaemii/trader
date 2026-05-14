'use client'
import { useState } from 'react'

interface BacktestResult {
  strategy_id: string
  passed: boolean
  failures: string[]
  oos_sharpe: number
  mean_ic: number
  deflated_sharpe: number
  pbo: number
  fdr_corrected_pvalue: number
  ablation_variants_tested: string[]
  completed_at: string
}

const STRATEGIES = ['factor_rank_v1', 'sector_momentum_v1', 'topology_v1'] as const

function isoToMs(d: string): number {
  return new Date(d + 'T00:00:00Z').getTime()
}

function defaultDates(): { start: string; end: string } {
  const end = new Date()
  const start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { start: fmt(start), end: fmt(end) }
}

export function BacktestRunner({ onComplete }: { onComplete?: () => void }) {
  const init = defaultDates()
  const [strategy, setStrategy] = useState<typeof STRATEGIES[number]>('factor_rank_v1')
  const [start, setStart] = useState(init.start)
  const [end, setEnd] = useState(init.end)
  const [nTrials, setNTrials] = useState(6)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/portal-api/admin/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategy_id: strategy,
          data_start_ms: isoToMs(start),
          data_end_ms: isoToMs(end),
          n_trials: nTrials,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(typeof data?.detail === 'string' ? data.detail : `Run failed (${res.status})`)
      } else {
        setResult(data as BacktestResult)
        onComplete?.()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <h2 className="mb-3 text-sm font-medium text-gray-300">Run backtest</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <label className="block text-xs">
          <span className="text-gray-400">Strategy</span>
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as typeof STRATEGIES[number])}
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 text-gray-200"
          >
            {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="block text-xs">
          <span className="text-gray-400">Start</span>
          <input
            type="date" value={start} onChange={(e) => setStart(e.target.value)}
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 text-gray-200"
          />
        </label>
        <label className="block text-xs">
          <span className="text-gray-400">End</span>
          <input
            type="date" value={end} onChange={(e) => setEnd(e.target.value)}
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 text-gray-200"
          />
        </label>
        <label className="block text-xs">
          <span className="text-gray-400">Ablation trials</span>
          <input
            type="number" min={1} max={20} value={nTrials}
            onChange={(e) => setNTrials(parseInt(e.target.value, 10) || 1)}
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 text-gray-200"
          />
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {running ? 'Running…' : 'Run'}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>

      {result && (
        <div className="mt-4 rounded border border-gray-800 bg-gray-950 p-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-gray-300">{result.strategy_id}</span>
            <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
              result.passed ? 'bg-emerald-700 text-white' : 'bg-red-700 text-white'
            }`}>{result.passed ? 'PASS' : 'FAIL'}</span>
            <span className="ml-auto font-mono text-gray-500">{result.completed_at}</span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-5">
            <Stat label="OOS Sharpe" value={result.oos_sharpe.toFixed(3)} />
            <Stat label="Mean IC" value={result.mean_ic.toFixed(4)} />
            <Stat label="Deflated SR" value={result.deflated_sharpe.toFixed(3)} />
            <Stat label="PBO" value={result.pbo.toFixed(3)} />
            <Stat label="FDR p-value" value={result.fdr_corrected_pvalue.toFixed(4)} />
          </dl>
          {result.failures.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Failures</div>
              <ul className="ml-4 list-disc text-red-300">
                {result.failures.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}
          <div className="mt-2 text-[10px] text-gray-500">
            Ablations tested: {result.ablation_variants_tested.join(', ')}
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="font-mono text-sm text-gray-200">{value}</div>
    </div>
  )
}
