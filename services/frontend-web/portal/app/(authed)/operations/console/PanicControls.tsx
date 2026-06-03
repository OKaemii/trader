'use client'

import { useState } from 'react'

interface Controls { killSwitch: boolean; paused: boolean }

export function PanicControls({ initial }: { initial: Controls }) {
  const [controls, setControls] = useState<Controls>(initial)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    const r = await fetch('/portal-api/admin/risk/controls').then((x) => x.json()).catch(() => null)
    if (r) setControls(r)
  }

  async function setFlag(kind: 'kill' | 'pause', on: boolean): Promise<void> {
    const path = kind === 'kill' ? '/portal-api/admin/risk/kill-switch' : '/portal-api/admin/strategy/pause'
    const label = kind === 'kill'
      ? (on ? 'ENGAGE the kill switch — halt ALL new orders AND the dispatcher drain' : 'release the kill switch and resume trading')
      : (on ? 'pause strategy emission (the dispatcher keeps draining in-flight orders)' : 'resume strategy emission')
    if (!window.confirm(`${on && kind === 'kill' ? '⚠ ' : ''}Confirm: ${label}?`)) return
    setBusy(kind); setMsg(null)
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) })
      if (!r.ok) throw new Error(`failed (${r.status})`)
      await refresh()
      setMsg(`${kind === 'kill' ? 'Kill switch' : 'Pause'} ${on ? 'engaged' : 'released'}.`)
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
  }

  async function flatten(): Promise<void> {
    if (!window.confirm('⚠ FLATTEN ALL — cancel every resting order AND market-sell every open position. Irreversible. Continue?')) return
    if (!window.confirm('Final confirm: sell the entire book at market, now?')) return
    setBusy('flatten'); setMsg(null)
    try {
      const r = await fetch('/portal-api/admin/trading/flatten', { method: 'POST' })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error ?? `failed (${r.status})`)
      setMsg(`Flatten done — cancelled ${b.cancelledOrders} order(s), sold ${b.soldPositions} position(s)${b.errors?.length ? `, ${b.errors.length} error(s)` : ''}.`)
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
  }

  const halted = controls.killSwitch
  return (
    <div className="space-y-4">
      <div className={`rounded border p-4 ${halted ? 'border-red-700 bg-red-950' : 'border-gray-800 bg-gray-900'}`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-gray-100">Global kill switch</h2>
            <p className="text-xs text-gray-400">Halts all new order generation <em>and</em> the dispatcher drain. {halted ? <span className="text-red-400">ENGAGED</span> : <span className="text-emerald-400">off</span>}</p>
          </div>
          <button
            onClick={() => setFlag('kill', !controls.killSwitch)}
            disabled={busy !== null}
            className={`rounded px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-50 ${halted ? 'bg-emerald-700 hover:bg-emerald-600' : 'bg-red-700 hover:bg-red-600'}`}
          >
            {busy === 'kill' ? '…' : halted ? 'Release' : 'ENGAGE KILL SWITCH'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex-1 rounded border border-gray-800 bg-gray-900 p-4">
          <h2 className="font-semibold text-gray-100">Pause emission</h2>
          <p className="mb-2 text-xs text-gray-400">Stops new signals; lets the queue finish. {controls.paused ? <span className="text-amber-300">paused</span> : <span className="text-emerald-400">running</span>}</p>
          <button onClick={() => setFlag('pause', !controls.paused)} disabled={busy !== null}
            className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-100 transition-colors hover:bg-gray-700 disabled:opacity-50">
            {busy === 'pause' ? '…' : controls.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
        <div className="flex-1 rounded border border-gray-800 bg-gray-900 p-4">
          <h2 className="font-semibold text-gray-100">Flatten all</h2>
          <p className="mb-2 text-xs text-gray-400">Cancel resting orders + market-sell every position (demo/live).</p>
          <button onClick={flatten} disabled={busy !== null}
            className="rounded bg-red-800 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50">
            {busy === 'flatten' ? 'Flattening…' : 'Flatten all'}
          </button>
        </div>
      </div>

      {msg && <div className="rounded border border-gray-800 bg-gray-950 px-4 py-2 text-sm text-amber-300">{msg}</div>}
    </div>
  )
}
