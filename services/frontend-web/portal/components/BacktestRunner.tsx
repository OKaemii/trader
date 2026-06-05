'use client'
import { useEffect, useState } from 'react'

const STRATEGIES = ['factor_rank_v1', 'sector_momentum_v1', 'topology_v1', 'high_velocity_v1'] as const

function isoToMs(d: string): number {
  return new Date(d + 'T00:00:00Z').getTime()
}

function msToIso(ms: unknown): string | null {
  return typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 10) : null
}

// Long default window: the walk-forward needs ≥2 folds + a 21-day embargo. Weekly rebalance over
// ~10y is the Phase-4 default for the daily strategy.
function defaultDates(): { start: string; end: string } {
  return { start: '2016-01-01', end: new Date().toISOString().slice(0, 10) }
}

// Submits a backtest as a queued job (returns {job_id}); the parent selects + polls it. No inline
// result — a completed job renders via BacktestReportView.
export function BacktestRunner({
  onSubmitted, initial,
}: { onSubmitted?: (jobId: string) => void; initial?: Record<string, unknown> | null }) {
  const init = defaultDates()
  const [strategy, setStrategy] = useState<typeof STRATEGIES[number]>('factor_rank_v1')
  const [start, setStart] = useState(init.start)
  const [end, setEnd] = useState(init.end)
  const [benchmark, setBenchmark] = useState('^GSPC')
  const [seed, setSeed] = useState(0)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Clone-to-form: prefill from a routed-in job request.
  useEffect(() => {
    if (!initial) return
    if (typeof initial.strategy_id === 'string' && (STRATEGIES as readonly string[]).includes(initial.strategy_id))
      setStrategy(initial.strategy_id as typeof STRATEGIES[number])
    const s = msToIso(initial.data_start_ms); if (s) setStart(s)
    const e = msToIso(initial.data_end_ms); if (e) setEnd(e)
    if (typeof initial.benchmark === 'string') setBenchmark(initial.benchmark)
    if (typeof initial.seed === 'number') setSeed(initial.seed)
  }, [initial])

  async function submit() {
    setBusy(true); setErr(null); setMsg(null)
    try {
      const res = await fetch('/portal-api/admin/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategy_id: strategy, data_start_ms: isoToMs(start), data_end_ms: isoToMs(end), benchmark, seed,
        }),
      })
      const data = await res.json()
      if (!res.ok) setErr(typeof data?.detail === 'string' ? data.detail : `Run failed (${res.status})`)
      else { setMsg(`Queued job ${data.job_id}`); onSubmitted?.(data.job_id) }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <h2 className="mb-1 text-sm font-medium text-gray-300">Run walk-forward backtest</h2>
      <p className="mb-3 text-[11px] text-gray-500">
        5-fold anchored walk-forward (21-day embargo), weekly rebalance, curated S&P 100. Queues and
        runs in the background (a few minutes) — fanned across cores.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <label className="block text-xs">
          <span className="text-gray-400">Strategy</span>
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as typeof STRATEGIES[number])}
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 text-gray-200">
            {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="block text-xs">
          <span className="text-gray-400">Start</span>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)}
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 text-gray-200" />
        </label>
        <label className="block text-xs">
          <span className="text-gray-400">End</span>
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)}
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 text-gray-200" />
        </label>
        <label className="block text-xs">
          <span className="text-gray-400">Benchmark</span>
          <input type="text" value={benchmark} onChange={(e) => setBenchmark(e.target.value.trim())}
            placeholder="^GSPC" className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 font-mono text-gray-200" />
        </label>
        <label className="block text-xs">
          <span className="text-gray-400">Seed</span>
          <input type="number" min={0} value={seed} onChange={(e) => setSeed(parseInt(e.target.value, 10) || 0)}
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 text-gray-200" />
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button type="button" onClick={submit} disabled={busy}
          className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {busy ? 'Queuing…' : 'Queue backtest'}
        </button>
        {msg && <span className="text-xs text-emerald-400">{msg}</span>}
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>
    </div>
  )
}
