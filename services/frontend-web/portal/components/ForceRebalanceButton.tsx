'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// "Rebalance now" — runs the active strategy's cycle on demand (via the rebalance proxy → strategy-engine
// /replay with force_rebalance), so a monthly strategy (high_velocity_v1) rebalances immediately instead
// of waiting for the month boundary. Preview is safe (dry run, no orders); Rebalance now PLACES ORDERS in
// Demo/Live, so it confirms-before-acting with a spelled-out consequence.
export function ForceRebalanceButton({ active }: { active: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState<false | 'preview' | 'live'>(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function run(dryRun: boolean): Promise<void> {
    if (
      !dryRun &&
      !window.confirm(
        `Rebalance "${active}" now? This bypasses the monthly schedule and runs a cycle immediately — in Demo/Live it PLACES ORDERS against the broker (a full rebalance of the held basket). Continue?`,
      )
    )
      return
    setBusy(dryRun ? 'preview' : 'live')
    setMsg(null)
    try {
      const r = await fetch('/portal-api/admin/strategy/rebalance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? `failed (${r.status})`)
      const verb = dryRun ? 'Preview' : 'Rebalance'
      setMsg(
        body.signal_emitted
          ? `${verb} done — ${active} emitted a cycle${dryRun ? ' (dry run — no orders placed).' : ' and published signals; the dispatcher is placing orders.'}`
          : `${verb} ran, but ${active} emitted nothing (held / quality screen empty / not enough history).`,
      )
      if (!dryRun) router.refresh()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <h2 className="mb-1 font-semibold text-gray-200">Force rebalance</h2>
      <p className="mb-3 text-xs text-gray-500">
        Run <span className="font-mono text-gray-300">{active || '—'}</span> now instead of waiting for its schedule (a
        monthly strategy only rebalances on the month boundary). <span className="text-gray-400">Preview</span> is safe;{' '}
        <span className="text-amber-300">Rebalance now</span> places orders in Demo/Live.
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => run(true)}
          disabled={!!busy || !active}
          className="rounded border border-gray-700 bg-gray-950 px-3 py-1.5 text-sm text-gray-100 transition-colors hover:bg-gray-800 disabled:opacity-50"
        >
          {busy === 'preview' ? 'Previewing…' : 'Preview (dry run)'}
        </button>
        <button
          onClick={() => run(false)}
          disabled={!!busy || !active}
          className="rounded bg-amber-800 px-3 py-1.5 text-sm text-amber-50 transition-colors hover:bg-amber-700 disabled:opacity-50"
        >
          {busy === 'live' ? 'Rebalancing…' : 'Rebalance now'}
        </button>
      </div>
      {msg && <div className="mt-2 text-xs text-amber-300">{msg}</div>}
    </div>
  )
}
