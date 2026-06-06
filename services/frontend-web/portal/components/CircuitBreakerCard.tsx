'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'

interface RiskStatus {
  circuit_open: boolean
  circuit_reason: string | null
  nav: number
  hwm: number
  daily_loss_pct: number
  drawdown_from_hwm_pct: number
  rejections_today: number
}

interface Props {
  initial: RiskStatus | null
}

// Dashboard card showing circuit-breaker state. The breaker stops new signal
// emission on a NAV-driven trip (daily loss > 3% or drawdown > 10%). Reset is
// manual after investigation — the trip post-mortem is captured in the
// Portfolio › Circuit Trips tab for forensics. See CLAUDE.md "Risk engine" section.
export function CircuitBreakerCard({ initial }: Props) {
  const [status, setStatus] = useState<RiskStatus | null>(initial)
  const [resetting, setResetting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Poll every 15s. The breaker can trip from background generate cycles, so a
  // stale dashboard would lie. 15s matches the auto-approve toggle cadence and
  // is well under the 5-min strategy cycle.
  useEffect(() => {
    const tick = async () => {
      try {
        const r = await fetch('/portal-api/admin/risk/status', { cache: 'no-store' })
        if (r.ok) setStatus(await r.json())
      } catch {
        // intentionally swallowed — transient fetch failures shouldn't blank the UI
      }
    }
    const id = setInterval(tick, 15_000)
    return () => clearInterval(id)
  }, [])

  async function handleReset() {
    if (!status?.circuit_open) return
    const ok = window.confirm(
      `Reset the circuit breaker?\n\n` +
      `Reason: ${status.circuit_reason ?? '(unknown)'}\n` +
      `NAV: £${status.nav.toFixed(2)}   HWM: £${status.hwm.toFixed(2)}\n` +
      `Daily loss: ${(status.daily_loss_pct * 100).toFixed(2)}%   Drawdown: ${(status.drawdown_from_hwm_pct * 100).toFixed(2)}%\n\n` +
      `If NAV is still below the trip thresholds, the breaker will re-trip on the next 5-min cycle. ` +
      `For a daily-loss trip you usually want to wait for UTC midnight (rebaselines day_open_nav). ` +
      `For a drawdown trip, NAV must climb back within 10% of HWM.`,
    )
    if (!ok) return
    setResetting(true)
    setError(null)
    try {
      const r = await fetch('/portal-api/admin/risk/circuit-breaker/reset', { method: 'POST' })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        setError(body.error ?? `Reset failed (${r.status})`)
      } else {
        setStatus({ ...status, circuit_open: false, circuit_reason: null })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setResetting(false)
    }
  }

  if (!status) {
    return (
      <div className="rounded border border-gray-800 bg-gray-900 p-4">
        <h2 className="text-sm font-medium text-gray-300">Circuit breaker</h2>
        <p className="mt-1 text-xs text-gray-500">Status unavailable.</p>
      </div>
    )
  }

  const tripped = status.circuit_open
  const dailyLossPct = (status.daily_loss_pct * 100).toFixed(2)
  const drawdownPct  = (status.drawdown_from_hwm_pct * 100).toFixed(2)

  return (
    <div className={`rounded border p-4 ${tripped ? 'border-red-700 bg-red-950/40' : 'border-gray-800 bg-gray-900'}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-gray-300">Circuit breaker</h2>
          <p className="mt-1 text-xs">
            {tripped ? (
              <span className="text-red-300">TRIPPED — {status.circuit_reason ?? 'reason unavailable'}</span>
            ) : (
              <span className="text-emerald-400">OK — accepting signals</span>
            )}
          </p>
          <p className="mt-2 text-[11px] text-gray-500">
            daily {dailyLossPct}% · dd {drawdownPct}% · rejects {status.rejections_today}
          </p>
        </div>
        {tripped && (
          <button
            type="button"
            onClick={handleReset}
            disabled={resetting}
            className="shrink-0 rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            {resetting ? 'Resetting…' : 'Reset'}
          </button>
        )}
      </div>
      <Link href="/portfolio?tab=trips" className="mt-2 inline-block text-[11px] text-gray-400 underline hover:text-gray-200">
        Trip history & post-mortems →
      </Link>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}
