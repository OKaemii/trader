'use client'

import { useState } from 'react'

interface SwingScreenRow {
  ticker: string
  close: number
  pctFrom52wHigh: number
  volSurge: number
  signals: string[]
  score: number
}
export interface ScreenSnapshot {
  runAt: number | null
  criteria?: { near52wHighPct: number; volSurgeMult: number; pullbackBandPct: number; topN: number }
  rows: SwingScreenRow[]
  scanned?: number
}

const SIGNAL_LABEL: Record<string, string> = {
  near_52w_high: '52w high',
  breakout_50ma: '50-MA breakout',
  unusual_volume: 'unusual vol',
  pullback_uptrend: 'pullback',
}

export function ScreenerView({ initial }: { initial: ScreenSnapshot | null }) {
  const [snap, setSnap] = useState<ScreenSnapshot | null>(initial)
  const [running, setRunning] = useState(false)
  const [criteria, setCriteria] = useState(initial?.criteria ?? { near52wHighPct: 0.05, volSurgeMult: 1.5, pullbackBandPct: 0.03, topN: 10 })

  const refresh = async () => {
    const res = await fetch('/portal-api/admin/market-data/screener/latest', { cache: 'no-store' })
    if (res.ok) setSnap(await res.json().catch(() => null))
  }

  const run = async () => {
    if (!window.confirm('Run the swing screener now? This scans the full universe and writes a new snapshot.')) return
    setRunning(true)
    try {
      await fetch('/portal-api/admin/market-data/screener/run', { method: 'POST' })
      await refresh()
    } finally {
      setRunning(false)
    }
  }

  const saveThresholds = async () => {
    if (!window.confirm('Save screener thresholds? Takes effect on the next run.')) return
    await fetch('/portal-api/admin/market-data/screener/thresholds', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(criteria),
    })
  }

  const rows = snap?.rows ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-500">
          {snap?.runAt ? `Last run ${new Date(snap.runAt).toLocaleString()} · scanned ${snap.scanned ?? '—'}` : 'No run yet'}
        </div>
        <button onClick={() => void run()} disabled={running} className="rounded bg-emerald-700 px-3 py-1 text-sm hover:bg-emerald-600 disabled:opacity-50">
          {running ? 'Running…' : 'Run now'}
        </button>
      </div>

      <div className="overflow-x-auto rounded border border-gray-800 bg-gray-900">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2">Ticker</th>
              <th className="px-3 py-2 text-right">Close</th>
              <th className="px-3 py-2 text-right">From 52w high</th>
              <th className="px-3 py-2 text-right">Vol surge</th>
              <th className="px-3 py-2">Signals</th>
              <th className="px-3 py-2 text-right">Score</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-500">No candidates in the latest run.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.ticker} className="text-gray-200">
                <td className="px-3 py-2 font-medium">{r.ticker.replace(/_US_EQ$/i, '').replace(/l_EQ$/i, '.L')}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.close.toFixed(2)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{(r.pctFrom52wHigh * 100).toFixed(1)}%</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.volSurge.toFixed(1)}×</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {r.signals.map((s) => (
                      <span key={s} className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-emerald-300">{SIGNAL_LABEL[s] ?? s}</span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-400">{r.score.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="rounded border border-gray-800 bg-gray-900 p-3 text-sm">
        <summary className="cursor-pointer text-gray-300">Thresholds</summary>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {([
            ['near52wHighPct', 'Within % of 52w high'],
            ['volSurgeMult', 'Vol surge ×'],
            ['pullbackBandPct', 'Pullback band %'],
            ['topN', 'Top N'],
          ] as const).map(([key, label]) => (
            <label key={key} className="block text-xs text-gray-400">
              {label}
              <input
                type="number"
                step="any"
                value={criteria[key]}
                onChange={(e) => setCriteria((c) => ({ ...c, [key]: Number(e.target.value) }))}
                className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-gray-100"
              />
            </label>
          ))}
        </div>
        <button onClick={() => void saveThresholds()} className="mt-3 rounded bg-gray-700 px-3 py-1 text-xs hover:bg-gray-600">Save thresholds</button>
      </details>
    </div>
  )
}
