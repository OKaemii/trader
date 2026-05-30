'use client'

import { useEffect, useState } from 'react'

// Feature audit: reconstruct the exact FeatureVector a strategy saw at a past instant
// (bi-temporal as-of read). Pick a recent signal — it carries strategy_id + timestamp — and
// the panel fills + runs the lookup. Manual entry stays available as a fallback.
type FeatureResponse = {
  found: boolean
  feature_vector?: Record<string, unknown>
  reason?: string
}

// Minimal mirror of the signal-service TradeSignal fields we need (see
// services/signal-service/src/modules/signals/domain/TradeSignal.ts).
type RecentSignal = {
  id: string
  timestamp: number
  ticker: string
  strategy_id: string
}

export function FeatureAuditPanel() {
  const [strategyId, setStrategyId] = useState('factor_rank_v1')
  const [asOfMs, setAsOfMs] = useState('')
  const [signals, setSignals] = useState<RecentSignal[]>([])
  const [result, setResult] = useState<FeatureResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/portal-api/admin/signals/history?limit=50')
      .then((r) => r.json())
      .then((d: { signals?: RecentSignal[] }) => {
        if (!cancelled) setSignals(Array.isArray(d.signals) ? d.signals : [])
      })
      .catch(() => {
        /* picker is optional — manual entry still works */
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function lookup(sid: string, ts: string) {
    if (!sid || !ts) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const r = await fetch(
        `/portal-api/admin/strategy/features?strategy_id=${encodeURIComponent(sid)}&as_of_ms=${encodeURIComponent(ts)}`,
      )
      setResult((await r.json()) as FeatureResponse)
    } catch {
      setError('Lookup failed — strategy-engine unreachable or feature store not wired.')
    } finally {
      setLoading(false)
    }
  }

  function pickSignal(s: RecentSignal) {
    setStrategyId(s.strategy_id)
    setAsOfMs(String(s.timestamp))
    void lookup(s.strategy_id, String(s.timestamp))
  }

  return (
    <section className="rounded border border-gray-800 bg-gray-900 p-4">
      <h2 className="mb-1 text-sm font-medium text-gray-300">Feature audit</h2>
      <p className="mb-3 text-xs text-gray-400">
        Reconstruct the exact feature vector a strategy saw at a past instant (bi-temporal as-of
        read). Pick a recent signal, or enter <code className="text-gray-300">strategy_id</code> +{' '}
        <code className="text-gray-300">timestamp</code> (UTC ms) manually.
      </p>

      {signals.length > 0 && (
        <div className="mb-3">
          <label className="mb-1 block text-xs text-gray-400">Recent signals</label>
          <div className="max-h-40 overflow-auto rounded border border-gray-800">
            {signals.map((s) => (
              <button
                key={s.id}
                onClick={() => pickSignal(s)}
                className="flex w-full items-center justify-between gap-3 border-b border-gray-800 px-2 py-1 text-left text-[11px] text-gray-300 last:border-b-0 hover:bg-gray-800"
              >
                <span className="font-mono text-emerald-400">{s.ticker}</span>
                <span className="text-gray-400">{s.strategy_id}</span>
                <span className="text-gray-500">{new Date(s.timestamp).toISOString().replace('T', ' ').slice(0, 19)}Z</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs text-gray-400">
          strategy_id
          <input
            value={strategyId}
            onChange={(e) => setStrategyId(e.target.value)}
            className="mt-1 w-48 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-200"
          />
        </label>
        <label className="flex flex-col text-xs text-gray-400">
          timestamp (UTC ms)
          <input
            value={asOfMs}
            onChange={(e) => setAsOfMs(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="1700000000000"
            className="mt-1 w-48 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-200"
          />
        </label>
        <button
          onClick={() => lookup(strategyId, asOfMs)}
          disabled={loading || !strategyId || !asOfMs}
          className="rounded bg-emerald-700 px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {loading ? 'Looking up…' : 'Look up'}
        </button>
      </div>

      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
      {result && !result.found && (
        <p className="mt-3 text-xs text-amber-300">
          No feature row found{result.reason ? ` — ${result.reason}` : ''}. (Feature store starts
          populating from the first strategy cycle after this deploy.)
        </p>
      )}
      {result?.found && result.feature_vector && (
        <pre className="mt-3 max-h-96 overflow-auto rounded bg-gray-950 p-3 text-[11px] leading-relaxed text-gray-300">
          {JSON.stringify(result.feature_vector, null, 2)}
        </pre>
      )}
    </section>
  )
}
