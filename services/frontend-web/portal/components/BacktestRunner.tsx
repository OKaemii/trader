'use client'
import { useState } from 'react'

// Benchmark overlay shape — mirror of BenchmarkComparison.as_dict() in
// services/backtest-engine/src/application/benchmark.py.
interface BenchmarkComparison {
  benchmark: string
  periods: number
  strategy_total_return: number
  benchmark_total_return: number
  excess_total_return: number
  alpha_annual: number
  beta: number
  information_ratio: number
  beats_market: boolean
}

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
  engine: string                 // 'replay' = real walk-forward; 'synthetic' = placeholder
  data_source?: string
  benchmark?: BenchmarkComparison | null
  completed_at: string
}

const STRATEGIES = ['factor_rank_v1', 'sector_momentum_v1', 'topology_v1'] as const

function isoToMs(d: string): number {
  return new Date(d + 'T00:00:00Z').getTime()
}

// Default to a long window: the walk-forward needs ≥2 folds + a 21-day embargo, so the old
// 90-day default could never produce a real replay. Weekly rebalance over ~10y is the
// Phase-4 default for the daily strategy.
function defaultDates(): { start: string; end: string } {
  const end = new Date()
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { start: '2016-01-01', end: fmt(end) }
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

export function BacktestRunner({ onComplete }: { onComplete?: () => void }) {
  const init = defaultDates()
  const [strategy, setStrategy] = useState<typeof STRATEGIES[number]>('factor_rank_v1')
  const [start, setStart] = useState(init.start)
  const [end, setEnd] = useState(init.end)
  const [benchmark, setBenchmark] = useState('^GSPC')
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
          benchmark,
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

  const isSynthetic = result?.engine === 'synthetic'
  const bm = result?.benchmark ?? null

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
          <span className="text-gray-400">Benchmark</span>
          <input
            type="text" value={benchmark} onChange={(e) => setBenchmark(e.target.value.trim())}
            placeholder="^GSPC"
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 font-mono text-gray-200"
          />
        </label>
      </div>
      <p className="mt-2 text-[10px] text-gray-500">
        Weekly rebalance, 5-fold anchored walk-forward (21-day embargo). Universe defaults to the
        curated S&P 100 (current membership — survivorship-biased; point-in-time constituents are
        a later phase). A full multi-year run takes a few minutes.
      </p>
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
            {isSynthetic ? (
              <span className="rounded bg-red-700 px-2 py-0.5 text-[10px] font-semibold uppercase text-white">
                Synthetic — not a real backtest
              </span>
            ) : (
              <>
                <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
                  result.passed ? 'bg-emerald-700 text-white' : 'bg-red-700 text-white'
                }`}>{result.passed ? 'PASS' : 'FAIL'}</span>
                <span className="rounded bg-gray-700 px-2 py-0.5 text-[10px] font-semibold uppercase text-gray-200">replay</span>
              </>
            )}
            <span className="ml-auto font-mono text-gray-500">{result.completed_at}</span>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-5">
            <Stat label="OOS Sharpe" value={result.oos_sharpe.toFixed(3)} />
            <Stat label="Mean IC" value={result.mean_ic.toFixed(4)} />
            <Stat label="Deflated SR" value={result.deflated_sharpe.toFixed(3)} />
            <Stat label="PBO" value={result.pbo.toFixed(3)} />
            <Stat label="FDR p-value" value={result.fdr_corrected_pvalue.toFixed(4)} />
          </dl>

          {bm && (
            <div className="mt-3 rounded border border-gray-800 bg-gray-900 p-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide text-gray-500">vs {bm.benchmark}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                  bm.beats_market ? 'bg-emerald-700 text-white' : 'bg-amber-700 text-white'
                }`}>{bm.beats_market ? 'beats market' : 'trails market'}</span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-5">
                <Stat label="Strategy ret" value={pct(bm.strategy_total_return)} />
                <Stat label="Benchmark ret" value={pct(bm.benchmark_total_return)} />
                <Stat label="Excess" value={pct(bm.excess_total_return)} />
                <Stat label="Alpha (ann)" value={pct(bm.alpha_annual)} />
                <Stat label="Beta / IR" value={`${bm.beta.toFixed(2)} / ${bm.information_ratio.toFixed(2)}`} />
              </dl>
            </div>
          )}

          {result.failures.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Failures</div>
              <ul className="ml-4 list-disc text-red-300">
                {result.failures.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}
          <div className="mt-2 text-[10px] text-gray-500">
            Ablations tested: {result.ablation_variants_tested.join(', ') || '—'}
          </div>
          {result.data_source && (
            <div className="mt-1 text-[10px] text-gray-600">{result.data_source}</div>
          )}
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
