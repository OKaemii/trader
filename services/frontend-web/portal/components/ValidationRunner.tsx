'use client'
import { useEffect, useState } from 'react'

const STRATEGIES = ['factor_rank_v1', 'sector_momentum_v1', 'topology_v1'] as const
const OBJECTIVES = ['profit_factor', 'sharpe', 'cum_return', 'ic_mean'] as const

function isoToMs(d: string): number {
  return new Date(d + 'T00:00:00Z').getTime()
}

function msToIso(ms: unknown): string | null {
  return typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 10) : null
}

function defaultDates(): { start: string; end: string } {
  return { start: '2016-01-01', end: new Date().toISOString().slice(0, 10) }
}

export function ValidationRunner({
  onSubmitted, initial,
}: { onSubmitted?: (jobId: string) => void; initial?: Record<string, unknown> | null }) {
  const init = defaultDates()
  const [strategy, setStrategy] = useState<typeof STRATEGIES[number]>('factor_rank_v1')
  const [start, setStart] = useState(init.start)
  const [end, setEnd] = useState(init.end)
  const [trainYears, setTrainYears] = useState(0)
  const [objective, setObjective] = useState<typeof OBJECTIVES[number]>('profit_factor')
  const [nIs, setNIs] = useState(200)
  const [nWf, setNWf] = useState(50)
  const [seed, setSeed] = useState(0)
  const [earlyStop, setEarlyStop] = useState(true)
  const [survivorshipFree, setSurvivorshipFree] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Clone-to-form: prefill from a routed-in job request.
  useEffect(() => {
    if (!initial) return
    if (typeof initial.strategy_id === 'string' && (STRATEGIES as readonly string[]).includes(initial.strategy_id))
      setStrategy(initial.strategy_id as typeof STRATEGIES[number])
    const s = msToIso(initial.start_ms); if (s) setStart(s)
    const e = msToIso(initial.end_ms); if (e) setEnd(e)
    if (typeof initial.train_years === 'number') setTrainYears(initial.train_years)
    if (typeof initial.objective_name === 'string' && (OBJECTIVES as readonly string[]).includes(initial.objective_name))
      setObjective(initial.objective_name as typeof OBJECTIVES[number])
    if (typeof initial.mcpt_n_in_sample === 'number') setNIs(initial.mcpt_n_in_sample)
    if (typeof initial.mcpt_n_wf === 'number') setNWf(initial.mcpt_n_wf)
    if (typeof initial.seed === 'number') setSeed(initial.seed)
    if (typeof initial.mcpt_early_stop === 'boolean') setEarlyStop(initial.mcpt_early_stop)
    if (typeof initial.survivorship_free === 'boolean') setSurvivorshipFree(initial.survivorship_free)
  }, [initial])

  async function submit() {
    setBusy(true); setErr(null); setMsg(null)
    try {
      const res = await fetch('/portal-api/admin/validator/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategy_id: strategy, start_ms: isoToMs(start), end_ms: isoToMs(end), train_years: trainYears,
          objective_name: objective, mcpt_n_in_sample: nIs, mcpt_n_wf: nWf, mcpt_early_stop: earlyStop,
          seed, survivorship_free: survivorshipFree,
        }),
      })
      const data = await res.json()
      if (!res.ok) setErr(typeof data?.detail === 'string' ? data.detail : `Submit failed (${res.status})`)
      else { setMsg(`Queued job ${data.job_id}`); onSubmitted?.(data.job_id) }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Submit failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <h2 className="mb-1 text-sm font-medium text-gray-300">Run permutation validation (MCPT)</h2>
      <p className="mb-3 text-[11px] text-gray-500">
        Four-step Monte-Carlo permutation test (IS fit → IS-MCPT → walk-forward → WF-MCPT), fanned
        across cores. Early-stop ends the run once the pass/fail verdict is locked — a clear fail
        finishes in <span className="text-amber-300">tens</span> of permutations instead of 1000.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <label className="block text-xs">
          <span className="text-gray-400">Strategy</span>
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as typeof STRATEGIES[number])}
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 text-gray-200">
            {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="block text-xs">
          <span className="text-gray-400">Objective</span>
          <select value={objective} onChange={(e) => setObjective(e.target.value as typeof OBJECTIVES[number])}
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 text-gray-200">
            {OBJECTIVES.map((o) => <option key={o} value={o}>{o}</option>)}
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
          <span className="text-gray-400">Train years (0 = 50/50)</span>
          <input type="number" min={0} max={20} step={0.5} value={trainYears}
            onChange={(e) => setTrainYears(parseFloat(e.target.value) || 0)}
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 text-gray-200" />
        </label>
        <label className="block text-xs">
          <span className="text-gray-400">IS permutations</span>
          <input type="number" min={1} max={2000} value={nIs}
            onChange={(e) => setNIs(parseInt(e.target.value, 10) || 1)}
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 text-gray-200" />
        </label>
        <label className="block text-xs">
          <span className="text-gray-400">WF permutations</span>
          <input type="number" min={1} max={500} value={nWf}
            onChange={(e) => setNWf(parseInt(e.target.value, 10) || 1)}
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 text-gray-200" />
        </label>
        <label className="block text-xs">
          <span className="text-gray-400">Seed</span>
          <input type="number" min={0} value={seed} onChange={(e) => setSeed(parseInt(e.target.value, 10) || 0)}
            className="mt-1 w-full rounded bg-gray-950 px-2 py-1.5 text-gray-200" />
        </label>
        <label className="flex items-end gap-2 text-xs">
          <input type="checkbox" checked={earlyStop} onChange={(e) => setEarlyStop(e.target.checked)}
            className="mb-2 h-4 w-4 rounded bg-gray-950" />
          <span className="mb-1.5 text-gray-400">Early-stop (verdict-locked)</span>
        </label>
        <label className="flex items-end gap-2 text-xs">
          <input type="checkbox" checked={survivorshipFree} onChange={(e) => setSurvivorshipFree(e.target.checked)}
            className="mb-2 h-4 w-4 rounded bg-gray-950" />
          <span className="mb-1.5 text-gray-400">Survivorship-free universe (point-in-time S&P 500)</span>
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button type="button" onClick={submit} disabled={busy}
          className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {busy ? 'Submitting…' : 'Queue validation'}
        </button>
        {msg && <span className="text-xs text-emerald-400">{msg}</span>}
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>
    </div>
  )
}
