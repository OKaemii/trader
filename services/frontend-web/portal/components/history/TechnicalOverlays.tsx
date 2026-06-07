'use client'

import { useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'

// Technical overlays for the History tab (T28, plan §H) — supplemental EODHD Technical indicators
// (MACD / ADX / ATR / Bollinger / beta) we deliberately do NOT compute client-side. DISPLAY /
// SUPPLEMENT ONLY: the trading factors stay computed in quant-core for live/replay parity. Fetched
// on demand (per overlay) through the metered passthrough endpoint
// (/portal-api/admin/market-data/technical?ticker=&func=) so an unviewed symbol spends no EODHD
// budget. The endpoint degrades to empty points on budget exhaustion / not-entitled / error — we
// render an honest "no data" rather than a fabricated series.
//
// The History tab mounts this under <QuantOnly> (advanced supplement; never a safety surface).

interface TechnicalPoint {
  date: string
  values: Record<string, number>
}

// The overlays offered + the EODHD function each maps to. Kept in sync with the endpoint's
// allow-list (services/market-data-service/.../technical/routes.ts TECHNICAL_FUNCS).
const OVERLAYS = [
  { key: 'macd', label: 'MACD' },
  { key: 'adx', label: 'ADX' },
  { key: 'atr', label: 'ATR' },
  { key: 'bbands', label: 'Bollinger' },
  { key: 'beta', label: 'Beta' },
] as const
type OverlayKey = (typeof OVERLAYS)[number]['key']

// Distinct colours for the (up to ~3) value-series an indicator emits (e.g. MACD: macd/signal/
// divergence; Bollinger: upper/middle/lower).
const SERIES_COLORS = ['#34d399', '#60a5fa', '#fbbf24', '#f472b6', '#a78bfa']

export function TechnicalOverlays({ symbol }: { symbol: string }) {
  const [func, setFunc] = useState<OverlayKey | null>(null)
  const [points, setPoints] = useState<TechnicalPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = async (f: OverlayKey) => {
    setFunc(f)
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch(
        `/portal-api/admin/market-data/technical?ticker=${encodeURIComponent(symbol)}&func=${f}`,
        { cache: 'no-store' },
      )
      const d = await res.json().catch(() => null)
      if (!res.ok || !Array.isArray(d?.points)) {
        setErr(`No ${f.toUpperCase()} data for ${symbol}`)
        setPoints([])
        return
      }
      setPoints(d.points as TechnicalPoint[])
    } catch {
      setErr('Failed to load indicator')
      setPoints([])
    } finally {
      setLoading(false)
    }
  }

  // The value keys to plot = the union of keys across points (EODHD names them per function).
  const seriesKeys = points.length > 0 ? Object.keys(points[0]!.values) : []

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-400">
        Supplemental indicators from EODHD (display only — the strategy factors are computed in
        quant-core). Pick one to load; each fetch is metered, so we load on demand.
      </p>
      <div className="flex flex-wrap gap-1">
        {OVERLAYS.map((o) => (
          <button
            key={o.key}
            onClick={() => void load(o.key)}
            className={`rounded px-2 py-1 text-sm ${
              func === o.key ? 'bg-gray-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {o.label}
          </button>
        ))}
        {loading && <span className="self-center text-xs text-gray-500">loading…</span>}
      </div>

      {func === null ? (
        <div className="rounded border border-gray-800 bg-gray-900/40 px-4 py-3 text-sm text-gray-500">
          Select an indicator to load its series.
        </div>
      ) : err ? (
        <div className="rounded border border-amber-900 bg-amber-950 px-4 py-2 text-sm text-amber-300">{err}</div>
      ) : !loading && points.length === 0 ? (
        <div className="rounded border border-gray-800 bg-gray-900 px-4 py-3 text-sm text-gray-400">
          No data returned (the feed may be rate-limited or unentitled for this symbol).
        </div>
      ) : (
        <div className="rounded border border-gray-800 bg-gray-900 p-2">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={points.map((p) => ({ date: p.date, ...p.values }))} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
              <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 10 }} minTickGap={48} />
              <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} width={48} />
              <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: 'none', color: '#fff', fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {seriesKeys.map((k, i) => (
                <Line key={k} type="monotone" dataKey={k} stroke={SERIES_COLORS[i % SERIES_COLORS.length]} dot={false} strokeWidth={1.5} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
