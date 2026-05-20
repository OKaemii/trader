'use client'
import { useState } from 'react'

export function DangerZone() {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string; detail?: unknown } | null>(null)

  async function performReset() {
    if (confirm !== 'RESET') return
    setPending(true)
    setResult(null)
    try {
      const r = await fetch('/portal-api/admin/system/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm }),
      })
      const data = await r.json()
      if (r.ok) {
        setResult({ ok: true, message: data.note ?? 'Reset complete.', detail: data.result })
        setConfirm('')
      } else {
        setResult({ ok: false, message: data.error ?? `Reset failed (${r.status})` })
      }
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : 'Reset failed' })
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="rounded border border-red-900/50 bg-red-950/20">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <h2 className="text-sm font-medium text-red-300">Danger zone</h2>
          <p className="mt-0.5 text-xs text-red-300/60">
            Reset trading history and strategy state to start fresh from today.
          </p>
        </div>
        <span className="text-red-400">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-red-900/50 px-4 py-4">
          <div className="space-y-1 text-xs text-red-200/80">
            <p><strong>Wipes</strong> Mongo collections: signals, ohlcv_bars, orders, positions, backtest_results, instrument_registry, topology_snapshots, strategy_health_log, model_versions, feature_importance_log, risk_state, risk_rejections, circuit_breaker_trips, bad_ticks.</p>
            <p><strong>Clears Redis</strong> streams (market:raw, signals:strategy) + state keys (strategy:*, regime:*, trading:*, signal:auto_approve).</p>
            <p><strong>Preserves</strong> users, universe overrides, market-data config.</p>
            <p className="text-red-400">
              T212 broker holdings are external and unchanged. To reset broker state, manually close positions in T212 first. Restart pods after reset to clear in-memory caches.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder='Type "RESET" to confirm'
              className="flex-1 rounded border border-red-900 bg-gray-950 px-3 py-1.5 text-sm text-gray-100 placeholder:text-red-700"
              disabled={pending}
            />
            <button
              type="button"
              onClick={performReset}
              disabled={confirm !== 'RESET' || pending}
              className="rounded bg-red-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-30 disabled:hover:bg-red-700"
            >
              {pending ? 'Wiping…' : 'Reset'}
            </button>
          </div>
          {result && (
            <div className={`rounded border px-3 py-2 text-xs ${
              result.ok
                ? 'border-emerald-900 bg-emerald-950/40 text-emerald-300'
                : 'border-red-900 bg-red-950/40 text-red-300'
            }`}>
              <p>{result.message}</p>
              {result.detail !== undefined && (
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-gray-400">
                  {JSON.stringify(result.detail, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
