'use client'
import { useEffect, useMemo, useState } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts'
import type { SignalProgressDTO } from '@/types/trader'
import { resolveSector } from './sectorLookup'
import { MARKET_STYLES, marketOf } from './market'
import { MarketBadge } from './MarketBadge'

interface Position {
  ticker?: string
  quantity?: number
  averagePrice?: number
  currentPrice?: number
  ppl?: number  // T212 unrealised P&L
}

interface PositionsResp { positions?: Position[]; mode?: string; error?: string }
interface UniverseResp { sectorMap?: Record<string, string>; activeUniverse?: string[] }

const SECTOR_COLOURS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#84cc16',
]

export function HoldingsPanel() {
  const [pos, setPos] = useState<PositionsResp | null>(null)
  const [universe, setUniverse] = useState<UniverseResp | null>(null)
  const [signals, setSignals] = useState<SignalProgressDTO[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [pRes, uRes, sRes] = await Promise.all([
          fetch('/portal-api/admin/trading/positions').then((r) => r.json()),
          fetch('/portal-api/admin/universe/overrides').then((r) => r.json()),
          fetch('/portal-api/signals/progress').then((r) => r.json()),
        ])
        if (cancelled) return
        setPos(pRes)
        setUniverse(uRes)
        setSignals(sRes.signals ?? [])
      } catch { /* swallow */ }
      finally { if (!cancelled) setLoading(false) }
    }
    load()
    const id = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const sectorMap = universe?.sectorMap ?? {}
  const positions = pos?.positions ?? []

  // Aggregate sector exposure weighted by position value. For positions on tickers absent
  // from the sectorMap (e.g. instruments held but no longer in the active universe) we
  // label them "Unknown" instead of dropping them — otherwise the chart silently understates.
  const sectorBreakdown = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const p of positions) {
      if (!p.ticker || !p.quantity || !p.currentPrice) continue
      const value = p.quantity * p.currentPrice
      const sector = resolveSector(p.ticker, sectorMap)
      totals[sector] = (totals[sector] ?? 0) + value
    }
    return Object.entries(totals)
      .map(([sector, value]) => ({ sector, value }))
      .sort((a, b) => b.value - a.value)
  }, [positions, sectorMap])

  const heldTickers = new Set(positions.map((p) => p.ticker).filter(Boolean) as string[])
  const heldSignals = signals.filter((s) => heldTickers.has(s.ticker)).slice(0, 8)

  if (loading) {
    return <div className="h-64 animate-pulse rounded bg-gray-800" />
  }

  if (pos?.mode === 'paper') {
    return (
      <div className="rounded border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
        Holdings unavailable in paper mode — set <code className="text-gray-300">TRADING_MODE</code> to{' '}
        <code className="text-gray-300">demo</code> or <code className="text-gray-300">live</code> to surface broker positions.
      </div>
    )
  }

  if (pos?.error) {
    return (
      <div className="rounded border border-red-900 bg-red-950 p-4 text-sm text-red-300">
        {pos.error}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="rounded border border-gray-800 bg-gray-900 p-4 lg:col-span-2">
        <h2 className="mb-3 text-sm font-medium text-gray-300">
          Holdings <span className="ml-2 text-xs text-gray-500">({positions.length})</span>
        </h2>
        {positions.length === 0 ? (
          <p className="text-xs text-gray-500">No open positions.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-gray-500">
              <tr className="border-b border-gray-800">
                <th className="py-1 text-left font-normal">Ticker</th>
                <th className="py-1 text-left font-normal">Sector</th>
                <th className="py-1 text-right font-normal">Qty</th>
                <th className="py-1 text-right font-normal">Avg</th>
                <th className="py-1 text-right font-normal">Last</th>
                <th className="py-1 text-right font-normal">P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p, i) => {
                const sector = resolveSector(p.ticker, sectorMap)
                const pnl = p.ppl
                const market = marketOf(p.ticker)
                const accent = MARKET_STYLES[market].border
                return (
                  <tr key={i} className={`border-b border-gray-800/50 border-l-2 ${accent}`}>
                    <td className="py-1.5 pl-2 font-mono text-gray-200">
                      <span className="inline-flex items-center gap-1.5">
                        <MarketBadge market={market} />
                        {p.ticker ?? '—'}
                      </span>
                    </td>
                    <td className="py-1.5 text-gray-400">{sector}</td>
                    <td className="py-1.5 text-right font-mono text-gray-300">{p.quantity?.toFixed(2) ?? '—'}</td>
                    <td className="py-1.5 text-right font-mono text-gray-300">{p.averagePrice?.toFixed(2) ?? '—'}</td>
                    <td className="py-1.5 text-right font-mono text-gray-300">{p.currentPrice?.toFixed(2) ?? '—'}</td>
                    <td className={`py-1.5 text-right font-mono ${
                      pnl === undefined ? 'text-gray-500' : pnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {pnl !== undefined ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-3 text-sm font-medium text-gray-300">Sector exposure</h2>
        {sectorBreakdown.length === 0 ? (
          <p className="text-xs text-gray-500">No data.</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={sectorBreakdown}
                dataKey="value"
                nameKey="sector"
                innerRadius={45}
                outerRadius={80}
                paddingAngle={2}
              >
                {sectorBreakdown.map((_, i) => (
                  <Cell key={i} fill={SECTOR_COLOURS[i % SECTOR_COLOURS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ backgroundColor: '#1f2937', border: 'none', color: '#fff' }}
                formatter={(v) => (v as number).toFixed(2)}
              />
              <Legend wrapperStyle={{ fontSize: 10, color: '#9ca3af' }} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="rounded border border-gray-800 bg-gray-900 p-4 lg:col-span-3">
        <h2 className="mb-3 text-sm font-medium text-gray-300">
          Signals on held tickers
          <span className="ml-2 text-xs text-gray-500">({heldSignals.length})</span>
        </h2>
        {heldSignals.length === 0 ? (
          <p className="text-xs text-gray-500">No active signals on positions you hold.</p>
        ) : (
          <ul className="space-y-1.5">
            {heldSignals.map((s) => {
              const market = marketOf(s.ticker)
              const accent = MARKET_STYLES[market].border
              return (
              <li key={s.id} className={`flex items-center justify-between rounded border-l-2 ${accent} bg-gray-950 px-3 py-2 text-xs`}>
                <div className="flex items-center gap-2">
                  <MarketBadge market={market} />
                  <span className="font-mono font-semibold text-white">{s.ticker}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    s.action === 'BUY' ? 'bg-emerald-700 text-white' :
                    s.action === 'SELL' ? 'bg-red-700 text-white' :
                    'bg-gray-700 text-gray-200'
                  }`}>{s.action}</span>
                  <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] uppercase text-gray-300">
                    {s.lifecycleResolved}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-gray-400">
                  <span>conf {(s.confidence * 100).toFixed(0)}%</span>
                  <span>tgt {(s.targetWeight * 100).toFixed(1)}%</span>
                  {s.pnlPct !== null && (
                    <span className={s.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {s.pnlPct >= 0 ? '+' : ''}{(s.pnlPct * 100).toFixed(2)}%
                    </span>
                  )}
                </div>
              </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
