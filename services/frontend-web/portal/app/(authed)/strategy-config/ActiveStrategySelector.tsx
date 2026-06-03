'use client'

import { useState } from 'react'

// One active strategy at a time. Persists the selection (PORTAL_RUNTIME_CONFIG); strategy
// selection is structural (universe source, rolling window, cross-cycle state), so it applies
// on the next strategy-engine restart — the confirm + the result message spell that out.
export function ActiveStrategySelector({ strategies, active }: { strategies: string[]; active: string }) {
  const [sel, setSel] = useState(active || strategies[0] || '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function save(): Promise<void> {
    if (!window.confirm(`Set the active strategy to "${sel}"? It applies on the next strategy-engine restart (strategy selection is structural — it changes the universe source + rolling window).`)) return
    setBusy(true); setMsg(null)
    try {
      const r = await fetch('/portal-api/admin/strategy/active', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy_id: sel }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? `failed (${r.status})`)
      setMsg(body.restartRequired
        ? `Saved. Restart strategy-engine to apply — currently running ${body.applied}.`
        : 'Saved — this strategy is already running.')
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <h2 className="mb-1 font-semibold text-gray-200">Active strategy</h2>
      <p className="mb-3 text-xs text-gray-500">One strategy runs at a time. Currently running: <span className="font-mono text-gray-300">{active || '—'}</span></p>
      <div className="flex items-center gap-2">
        <select
          value={sel}
          onChange={(e) => setSel(e.target.value)}
          className="rounded border border-gray-700 bg-gray-950 px-3 py-1.5 text-sm text-gray-100"
        >
          {strategies.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={save} disabled={busy || !sel} className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-100 transition-colors hover:bg-gray-700 disabled:opacity-50">
          {busy ? 'Saving…' : 'Set active'}
        </button>
      </div>
      {msg && <div className="mt-2 text-xs text-amber-300">{msg}</div>}
    </div>
  )
}
