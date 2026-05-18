'use client'
import { useState } from 'react'

interface AutoApproveToggleProps {
  // SSR-fetched initial value. Avoids the on-mount GET + state-null flicker that made
  // the slider appear to start in OFF position before snapping to the real state — the
  // user-visible "keeps coming off / takes a while to move right" complaint. Pass null
  // when the upstream fetch failed; the slider then renders OFF + disabled with no
  // pretence of a known state.
  initialEnabled: boolean | null
}

export function AutoApproveToggle({ initialEnabled }: AutoApproveToggleProps) {
  const [enabled, setEnabled] = useState<boolean | null>(initialEnabled)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle() {
    if (enabled === null || pending) return
    const next = !enabled
    if (next) {
      const ok = window.confirm(
        'Enable auto-approve?\n\n' +
        'Every signal generated will be auto-approved. In demo/live mode this places real ' +
        'broker orders without manual review. BUYs are pro-rated to fit free cash.',
      )
      if (!ok) return
    }
    setPending(true)
    setError(null)
    // Optimistic flip; rollback on failure.
    setEnabled(next)
    try {
      const r = await fetch('/portal-api/admin/signals/auto-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      if (!r.ok) {
        setEnabled(!next)
        const body = await r.json().catch(() => ({}))
        setError(body.error ?? `Failed (${r.status})`)
      }
    } catch (e) {
      setEnabled(!next)
      setError(e instanceof Error ? e.message : 'Toggle failed')
    } finally {
      setPending(false)
    }
  }

  const isOn = enabled === true
  const isLoading = enabled === null

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-gray-300">Auto-approve signals</h2>
          <p className="mt-1 text-xs text-gray-500">
            {isOn
              ? <span className="text-amber-300">ON — every emitted signal auto-approved. BUYs pro-rated to free cash.</span>
              : 'OFF — signals wait for manual approval.'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isOn}
          aria-label="Auto-approve signals"
          onClick={toggle}
          disabled={isLoading || pending}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
            isOn ? 'bg-amber-600' : 'bg-gray-700'
          } ${isLoading || pending ? 'opacity-50' : ''}`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-lg transition-transform duration-200 ${
              isOn ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}
