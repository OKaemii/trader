'use client'
import { useEffect, useMemo, useState } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts'
import { type SignalProgressDTO, type Money, SignalLifecycle } from '@/types/trader'
import { resolveSector } from './sectorLookup'
import { MARKET_STYLES, marketOf } from './market'
import { MarketBadge } from './MarketBadge'
import { TickerChip } from './TickerChip'

// Wire shape from /portal-api/admin/trading/positions (post-FX-fix). averagePrice /
// currentPrice / currentValue are Money-tagged so a USD-listed position shows USD prices.
// We deliberately do NOT FX-convert in the UI: each row displays in its own currency,
// labelled by a market badge. Sector exposure aggregates `currentValue.amount` directly
// because — short of doing FX in the browser — the cleanest "sector breakdown" is one
// per-currency. With most accounts holding either US or UK but not both heavily, the
// chart reads sensibly. A future enhancement could render a GBP-converted overlay.
interface Position {
  ticker?: string
  quantity?: number
  averagePrice?: Money
  currentPrice?: Money
  currentValue?: Money
  ppl?: number  // T212 unrealised P&L (instrument currency)
}

interface PositionsResp { positions?: Position[]; mode?: string; error?: string }
interface UniverseResp { sectorMap?: Record<string, string>; activeUniverse?: string[] }

const fmtPrice = (m?: Money) => m && typeof m.amount === 'number' ? m.amount.toFixed(2) : '—'

const SECTOR_COLOURS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#84cc16',
]

// SSR-fetched in dashboard/page.tsx (one Promise.all alongside health + cash) so the
// panel renders the table + sector pie + signals strip on first paint. 60s polling
// keeps it fresh after that.
export interface HoldingsInitial {
  positions?: PositionsResp | null
  universe?:  UniverseResp  | null
  signals?:   SignalProgressDTO[]
}

export function HoldingsPanel({ initial = null }: { initial?: HoldingsInitial | null } = {}) {
  const [pos, setPos] = useState<PositionsResp | null>(initial?.positions ?? null)
  const [universe, setUniverse] = useState<UniverseResp | null>(initial?.universe ?? null)
  const [signals, setSignals] = useState<SignalProgressDTO[]>(initial?.signals ?? [])
  const [loading, setLoading] = useState(initial === null)

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
    // SSR-seeded path: skip the immediate fetch and let the interval take over.
    if (initial === null) load()
    const id = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [initial])

  // Wrap the fallback expressions in useMemo so their identities only change when the
  // underlying source does — otherwise the `??` makes a fresh {} / [] every render and the
  // sectorBreakdown memo below (which depends on them) would recompute on every render.
  const sectorMap = useMemo(() => universe?.sectorMap ?? {}, [universe])
  const positions = useMemo(() => pos?.positions ?? [], [pos])

  // Aggregate sector exposure weighted by position value. For positions on tickers absent
  // from the sectorMap (e.g. instruments held but no longer in the active universe) we
  // label them "Unknown" instead of dropping them — otherwise the chart silently understates.
  const sectorBreakdown = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const p of positions) {
      if (!p.ticker || !p.quantity) continue
      // Prefer the explicit currentValue (Money) the backend computed; fall back to
      // qty × currentPrice for any oddly-shaped row. Both are in instrument currency —
      // see top-of-file note on why we don't FX-convert in the UI.
      const value = p.currentValue?.amount
        ?? (p.currentPrice?.amount ? p.quantity * p.currentPrice.amount : 0)
      if (value <= 0) continue
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

  if (pos?.mode === 'Paper') {
    return (
      <div className="rounded border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
        Holdings unavailable in paper mode — set <code className="text-gray-300">TRADING_MODE</code> to{' '}
        <code className="text-gray-300">Demo</code> or <code className="text-gray-300">Live</code> to surface broker positions.
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
                        {p.ticker ? <TickerChip symbol={p.ticker} /> : '—'}
                      </span>
                    </td>
                    <td className="py-1.5 text-gray-400">{sector}</td>
                    <td className="py-1.5 text-right font-mono text-gray-300">{p.quantity?.toFixed(2) ?? '—'}</td>
                    <td className="py-1.5 text-right font-mono text-gray-300">{fmtPrice(p.averagePrice)}</td>
                    <td className="py-1.5 text-right font-mono text-gray-300">{fmtPrice(p.currentPrice)}</td>
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
                  <TickerChip symbol={s.ticker} className="font-mono font-semibold text-white" />
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    s.action === 'BUY' ? 'bg-emerald-700 text-white' :
                    s.action === 'SELL' ? 'bg-red-700 text-white' :
                    'bg-gray-700 text-gray-200'
                  }`}>{s.action}</span>
                  <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] uppercase text-gray-300">
                    {SignalLifecycle[s.lifecycleResolved] ?? s.lifecycleResolved}
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
