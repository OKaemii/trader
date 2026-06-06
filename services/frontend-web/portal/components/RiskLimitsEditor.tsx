'use client'

import { useState } from 'react'
import { QuantOnly } from '@/components/QuantOnly'

// Mirrors the signal-service /admin/api/signals/risk/limits payload (RiskLimitsProvider).
export interface RiskLimitsView {
  effective: Record<string, number>
  overrides: Record<string, number>
  defaults: Record<string, number>
  tunableFields: string[]
  bounds: Record<string, [number, number]>
}

const LABELS: Record<string, { name: string; hint: string }> = {
  maxDailyLoss:           { name: 'Daily-loss halt',  hint: 'Circuit breaker trips if NAV falls this fraction intraday' },
  maxDrawdownHalt:        { name: 'Drawdown halt',    hint: 'Circuit breaker trips at this drawdown from the high-water mark' },
  maxSingleName:          { name: 'Max single name',  hint: 'Per-name weight cap applied by the optimiser' },
  maxSectorConcentration: { name: 'Max sector',       hint: 'Per-GICS-sector weight cap applied by the optimiser' },
  maxWeeklyTurnover:      { name: 'Weekly turnover',  hint: 'Turnover budget before the optimiser blends back toward current weights' },
}

const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`

// Circuit-breaker halt thresholds are SAFETY config — they stay visible in both modes. The
// optimiser caps (everything else) are the quant-only "internals" Beginner mode curates away.
// Categorise by an allow-list so an unknown future field stays visible (never hide safety).
const SAFETY_FIELDS = new Set(['maxDailyLoss', 'maxDrawdownHalt'])

function seedInputs(v: RiskLimitsView): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of v.tunableFields) out[f] = v.overrides[f] != null ? String(v.overrides[f]) : ''
  return out
}

export function RiskLimitsEditor({ initial }: { initial: RiskLimitsView }) {
  const [view, setView] = useState<RiskLimitsView>(initial)
  const [inputs, setInputs] = useState<Record<string, string>>(seedInputs(initial))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    const r = await fetch('/portal-api/admin/risk/limits').then((x) => x.json()).catch(() => null)
    if (r && r.tunableFields) { setView(r); setInputs(seedInputs(r)) }
  }

  function buildOverrides(): Record<string, number> {
    const o: Record<string, number> = {}
    for (const f of view.tunableFields) {
      const raw = (inputs[f] ?? '').trim()
      if (raw === '') continue
      const n = Number(raw)
      if (Number.isFinite(n)) o[f] = n
    }
    return o
  }

  async function save(): Promise<void> {
    const overrides = buildOverrides()
    const summary = view.tunableFields
      .map((f) => `${LABELS[f]?.name ?? f}: ${overrides[f] != null ? overrides[f] : 'default'}`)
      .join('\n')
    if (!window.confirm(`Apply these risk limits (hot — affects the live circuit breaker + optimiser on the next cycle)?\n\n${summary}`)) return
    setBusy(true); setMsg(null)
    try {
      const r = await fetch('/portal-api/admin/risk/limits', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overrides }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error ?? `failed (${r.status})`)
      await refresh()
      const dropped = Object.keys(overrides).filter((f) => b.overrides?.[f] == null)
      setMsg(dropped.length
        ? `Saved. ${dropped.length} value(s) out of range — reverted to default: ${dropped.join(', ')}.`
        : 'Saved — applied on the next signal cycle.')
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  async function resetAll(): Promise<void> {
    if (!window.confirm('Clear ALL risk-limit overrides and fall back to the compile-time defaults?')) return
    setBusy(true); setMsg(null)
    try {
      const r = await fetch('/portal-api/admin/risk/limits', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overrides: {} }),
      })
      if (!r.ok) throw new Error(`failed (${r.status})`)
      await refresh()
      setMsg('All overrides cleared — using compile-time defaults.')
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const dirty = view.tunableFields.some(
    (f) => (inputs[f] ?? '') !== (view.overrides[f] != null ? String(view.overrides[f]) : ''),
  )

  // Split the tunable fields by group, preserving server order within each. Save/refresh still
  // iterate the FULL view.tunableFields, so optimiser-cap rows hidden in Beginner keep their
  // seeded override value (no spurious dirty, nothing dropped on save).
  const safetyFields = view.tunableFields.filter((f) => SAFETY_FIELDS.has(f))
  const optimiserFields = view.tunableFields.filter((f) => !SAFETY_FIELDS.has(f))

  // Plain render helpers (NOT components — called directly, lowercase — so they don't reset
  // state per render and don't trip react-hooks/static-components). Both close over the live
  // view/inputs state, so the row markup stays single-sourced across the two group tables.
  const renderRow = (f: string) => {
    const meta = LABELS[f]
    const overridden = view.overrides[f] != null
    const [lo, hi] = view.bounds[f] ?? [0, 1]
    return (
      <tr key={f}>
        <td className="px-4 py-3">
          <div className="font-medium text-gray-100">{meta?.name ?? f}</div>
          <div className="text-xs text-gray-500">{meta?.hint ?? ''}</div>
        </td>
        <td className="px-4 py-3">
          <span className={overridden ? 'text-amber-300' : 'text-gray-200'}>{view.effective[f]}</span>
          <span className="ml-1 text-xs text-gray-500">({pct(view.effective[f] ?? 0)})</span>
        </td>
        <td className="px-4 py-3 text-gray-400">{view.defaults[f]}</td>
        <td className="px-4 py-3">
          <input
            type="number" step="0.01" min={lo} max={hi}
            value={inputs[f] ?? ''}
            placeholder={`${view.defaults[f]} (default)`}
            onChange={(e) => setInputs((s) => ({ ...s, [f]: e.target.value }))}
            className="w-32 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100 focus:border-emerald-600 focus:outline-none"
          />
        </td>
        <td className="px-4 py-3 text-xs text-gray-500">{lo} – {hi}</td>
      </tr>
    )
  }

  const renderTable = (caption: string, fields: string[]) =>
    fields.length === 0 ? null : (
      <div className="overflow-hidden rounded border border-gray-800">
        <table className="w-full text-sm">
          <caption className="bg-gray-900 px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-400">{caption}</caption>
          <thead className="bg-gray-900 text-left text-xs uppercase text-gray-400">
            <tr>
              <th className="px-4 py-2">Limit</th>
              <th className="px-4 py-2">Effective</th>
              <th className="px-4 py-2">Default</th>
              <th className="px-4 py-2">Override</th>
              <th className="px-4 py-2">Range</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800 bg-gray-950">
            {fields.map(renderRow)}
          </tbody>
        </table>
      </div>
    )

  return (
    <div className="space-y-4">
      {/* Circuit-breaker halt thresholds are safety config — visible in both modes. */}
      {renderTable('Circuit-breaker thresholds', safetyFields)}

      {/* Optimiser caps are quant-only internals — Beginner mode curates them away. The values are
          still applied; they're just not surfaced for editing in the simplified view. */}
      <QuantOnly>
        {renderTable('Optimiser caps', optimiserFields)}
      </QuantOnly>

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={save} disabled={busy || !dirty}
          className="rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50">
          {busy ? 'Saving…' : 'Save limits'}
        </button>
        <button onClick={resetAll} disabled={busy}
          className="rounded bg-gray-800 px-3 py-2 text-sm text-gray-100 transition-colors hover:bg-gray-700 disabled:opacity-50">
          Reset to defaults
        </button>
        <span className="text-xs text-gray-500">Empty field = use default. Applied on the next signal cycle.</span>
      </div>

      {msg && <div className="rounded border border-gray-800 bg-gray-950 px-4 py-2 text-sm text-amber-300">{msg}</div>}
    </div>
  )
}
