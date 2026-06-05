'use client'

import { useState } from 'react'

// Mirrors trading-service /admin/api/trading/equity (computeEquityKpis).
interface NavPoint { t: number; nav: number; cash: number; positionsValue: number }
interface Kpis {
  nSnapshots: number; firstAt: number | null; lastAt: number | null
  current: number; cash: number; positionsValue: number; start: number
  totalReturnPct: number; high: number; low: number; maxDrawdownPct: number; currentDrawdownPct: number
}
export interface EquityPayload { series: NavPoint[]; kpis: Kpis; days: number }

const RANGES = [30, 90, 365] as const
const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`
const fmtGbp = (v: number) => `£${v.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
const fmtDate = (t: number | null) => (t ? new Date(t).toLocaleDateString('en-GB') : '—')

function Sparkline({ series }: { series: NavPoint[] }) {
  if (series.length < 2) {
    return <div className="flex h-48 items-center justify-center text-sm text-gray-500">Not enough snapshots yet — the NAV ledger fills ~every 4h.</div>
  }
  const W = 800, H = 200, pad = 4
  const navs = series.map((p) => p.nav)
  const min = Math.min(...navs), max = Math.max(...navs)
  const span = max - min || 1
  const x = (i: number) => pad + (i / (series.length - 1)) * (W - 2 * pad)
  const y = (v: number) => pad + (1 - (v - min) / span) * (H - 2 * pad)
  const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.nav).toFixed(1)}`).join(' ')
  const up = navs[navs.length - 1]! >= navs[0]!
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={up ? '#34d399' : '#f87171'} strokeWidth={1.5} />
    </svg>
  )
}

export function EquityView({ initial }: { initial: EquityPayload }) {
  const [data, setData] = useState<EquityPayload>(initial)
  const [days, setDays] = useState<number>(initial.days)
  const [busy, setBusy] = useState(false)

  async function load(d: number): Promise<void> {
    setBusy(true)
    try {
      const r = await fetch(`/portal-api/admin/trading/equity?days=${d}`).then((x) => x.json()).catch(() => null)
      if (r && r.kpis) { setData(r); setDays(d) }
    } finally { setBusy(false) }
  }

  const k = data.kpis
  // Honest coverage: the NAV ledger fills ~every 4h, so live history is short early on. When the
  // recorded span is shorter than the selected window, every range renders the same data — say so
  // rather than letting it look like a broken toggle.
  const spanDays = k.firstAt && k.lastAt ? Math.max(1, Math.round((k.lastAt - k.firstAt) / 86_400_000)) : 0
  const shortHistory = k.nSnapshots > 0 && spanDays < days
  const cards: Array<[string, string, string?]> = [
    ['Total return', fmtPct(k.totalReturnPct), k.totalReturnPct >= 0 ? 'text-emerald-400' : 'text-red-400'],
    ['Current NAV', fmtGbp(k.current)],
    ['Max drawdown', fmtPct(k.maxDrawdownPct), 'text-red-400'],
    ['Current drawdown', fmtPct(k.currentDrawdownPct), k.currentDrawdownPct < 0 ? 'text-amber-300' : 'text-gray-200'],
    ['Period high', fmtGbp(k.high)],
    ['Period low', fmtGbp(k.low)],
    ['Cash / positions', `${fmtGbp(k.cash)} / ${fmtGbp(k.positionsValue)}`],
    ['Snapshots', `${k.nSnapshots}`],
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((d) => (
          <button
            key={d}
            onClick={() => load(d)}
            disabled={busy}
            className={`rounded px-3 py-1 text-sm transition-colors disabled:opacity-50 ${days === d ? 'bg-emerald-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
          >
            {d}d
          </button>
        ))}
        <span className="text-xs text-gray-500">{fmtDate(k.firstAt)} → {fmtDate(k.lastAt)} · {k.nSnapshots} snapshots</span>
        {shortHistory && (
          <span className="text-xs text-amber-300/80">
            Live NAV history spans ~{spanDays}d — longer ranges show the same data until more accrues.
          </span>
        )}
      </div>

      <div className="rounded border border-gray-800 bg-gray-950 p-4">
        <Sparkline series={data.series} />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map(([label, value, cls]) => (
          <div key={label} className="rounded border border-gray-800 bg-gray-900 p-3">
            <div className="text-xs text-gray-400">{label}</div>
            <div className={`mt-1 text-lg font-semibold ${cls ?? 'text-gray-100'}`}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
