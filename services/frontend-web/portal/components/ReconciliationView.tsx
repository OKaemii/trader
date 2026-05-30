'use client'

import { useEffect, useState } from 'react'

// Operator view of the three-way reconciliation ledger. SSR-seeded, then 15s poll (matches
// the dashboard cards). "Run now" + per-finding "Acknowledge" are confirm-before-mutate.
type Finding = {
  finding_id: number
  occurred_at: string
  ticker: string | null
  drift_type: string | null
  severity: string
  resolution: string
  diff?: Record<string, unknown>
}
type NavRow = { snapshot_at: string; cash: number; positions_value: number; nav: number; currency: string }

const sevColor: Record<string, string> = {
  major: 'text-red-400',
  minor: 'text-amber-300',
  clean: 'text-emerald-400',
  error: 'text-red-500',
}

export function ReconciliationView({
  initialFindings,
  initialNav,
}: {
  initialFindings: Finding[]
  initialNav: NavRow[]
}) {
  const [findings, setFindings] = useState<Finding[]>(initialFindings)
  const [nav, setNav] = useState<NavRow[]>(initialNav)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function refresh() {
    try {
      const [f, n] = await Promise.all([
        fetch('/portal-api/admin/trading/reconcile/findings?open=true&limit=100').then((r) => r.json()),
        fetch('/portal-api/admin/trading/reconcile/nav?limit=50').then((r) => r.json()),
      ])
      setFindings(Array.isArray(f.findings) ? f.findings : [])
      setNav(Array.isArray(n.nav) ? n.nav : [])
    } catch {
      /* keep last good */
    }
  }

  useEffect(() => {
    const t = setInterval(refresh, 15_000)
    return () => clearInterval(t)
  }, [])

  async function runNow() {
    if (!window.confirm('Run a reconciliation cycle now? This pulls live T212 truth and records findings + a NAV snapshot. (Auto-heal only mutates positions if RECONCILE_AUTO_HEAL is enabled.)')) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await fetch('/portal-api/admin/trading/reconcile/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"trigger":"manual"}' })
      const d = await r.json()
      setMsg(r.ok ? `Cycle complete: ${JSON.stringify(d.summary)}` : `Failed: ${d.error ?? r.status}`)
      await refresh()
    } catch {
      setMsg('Run failed — trading-service unreachable.')
    } finally {
      setBusy(false)
    }
  }

  async function acknowledge(id: number) {
    if (!window.confirm(`Acknowledge finding #${id}? It will be marked operator_acknowledged and drop off the open list.`)) return
    try {
      await fetch(`/portal-api/admin/trading/reconcile/findings/${id}/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"by":"operator"}' })
      await refresh()
    } catch {
      /* poll will re-sync */
    }
  }

  const latest = nav[0]

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={runNow} disabled={busy} className="rounded bg-emerald-700 px-3 py-1.5 text-sm text-white disabled:opacity-40">
          {busy ? 'Running…' : 'Run reconcile now'}
        </button>
        {msg && <span className="text-xs text-gray-400">{msg}</span>}
      </div>

      {latest && (
        <section className="rounded border border-gray-800 bg-gray-900 p-4">
          <h2 className="mb-2 text-sm font-medium text-gray-300">Latest NAV snapshot</h2>
          <div className="flex flex-wrap gap-6 text-sm">
            <div><span className="text-gray-500">NAV </span><span className="text-emerald-400">{latest.currency} {Number(latest.nav).toFixed(2)}</span></div>
            <div><span className="text-gray-500">Cash </span><span className="text-gray-200">{Number(latest.cash).toFixed(2)}</span></div>
            <div><span className="text-gray-500">Positions </span><span className="text-gray-200">{Number(latest.positions_value).toFixed(2)}</span></div>
            <div className="text-gray-500">{new Date(latest.snapshot_at).toISOString().replace('T', ' ').slice(0, 19)}Z</div>
          </div>
        </section>
      )}

      <section className="rounded border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-2 text-sm font-medium text-gray-300">Open findings ({findings.length})</h2>
        {findings.length === 0 ? (
          <p className="text-xs text-emerald-400">No open findings — system, broker, and ledger agree.</p>
        ) : (
          <table className="w-full text-left text-[12px]">
            <thead className="text-gray-500">
              <tr>
                <th className="py-1">Ticker</th><th>Drift</th><th>Severity</th><th>When</th><th>Diff</th><th />
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <tr key={f.finding_id} className="border-t border-gray-800">
                  <td className="py-1 font-mono text-emerald-400">{f.ticker ?? '—'}</td>
                  <td className="text-gray-300">{f.drift_type}</td>
                  <td className={sevColor[f.severity] ?? 'text-gray-300'}>{f.severity}</td>
                  <td className="text-gray-500">{new Date(f.occurred_at).toISOString().slice(5, 19).replace('T', ' ')}</td>
                  <td className="max-w-xs truncate text-gray-500">{JSON.stringify(f.diff ?? {})}</td>
                  <td><button onClick={() => acknowledge(f.finding_id)} className="rounded border border-gray-700 px-2 py-0.5 text-[11px] text-gray-300 hover:bg-gray-800">Ack</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
