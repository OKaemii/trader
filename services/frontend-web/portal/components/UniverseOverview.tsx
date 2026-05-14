'use client'
import { useMemo, useState } from 'react'
import type { ActiveInstrument } from '@/app/actions/admin'
import { MarketBadge } from './MarketBadge'
import { MARKET_STYLES } from './market'

interface Props {
  instruments: ActiveInstrument[]
  updatedAt: string | null
}

type SortKey = 'adv' | 'ticker' | 'sector' | 'market'

function fmtADV(adv: number): string {
  if (!adv) return '—'
  if (adv >= 1e9) return `${(adv / 1e9).toFixed(2)}B`
  if (adv >= 1e6) return `${(adv / 1e6).toFixed(2)}M`
  if (adv >= 1e3) return `${(adv / 1e3).toFixed(2)}K`
  return adv.toFixed(0)
}

export function UniverseOverview({ instruments, updatedAt }: Props) {
  const [sortBy, setSortBy] = useState<SortKey>('adv')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [filter, setFilter] = useState<'ALL' | 'US' | 'LSE' | 'OTHER'>('ALL')
  const [caveatOpen, setCaveatOpen] = useState(false)

  const stats = useMemo(() => {
    const us  = instruments.filter((i) => i.market === 'US').length
    const lse = instruments.filter((i) => i.market === 'LSE').length
    const other = instruments.length - us - lse
    return { total: instruments.length, us, lse, other }
  }, [instruments])

  const sorted = useMemo(() => {
    const filtered = filter === 'ALL' ? instruments : instruments.filter((i) => i.market === filter)
    const cmp = (a: ActiveInstrument, b: ActiveInstrument): number => {
      let x: number | string = 0, y: number | string = 0
      switch (sortBy) {
        case 'adv':    x = a.adv;    y = b.adv;    break
        case 'ticker': x = a.ticker; y = b.ticker; break
        case 'sector': x = a.sector; y = b.sector; break
        case 'market': x = a.market; y = b.market; break
      }
      if (typeof x === 'number' && typeof y === 'number') return x - y
      return String(x).localeCompare(String(y))
    }
    const arr = [...filtered].sort(cmp)
    return sortDir === 'desc' ? arr.reverse() : arr
  }, [instruments, sortBy, sortDir, filter])

  const maxAdv = useMemo(
    () => sorted.reduce((m, i) => Math.max(m, i.adv), 0),
    [sorted],
  )

  function toggleSort(k: SortKey) {
    if (sortBy === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else { setSortBy(k); setSortDir(k === 'adv' ? 'desc' : 'asc') }
  }

  const indicator = (k: SortKey) => sortBy !== k ? '' : (sortDir === 'asc' ? ' ↑' : ' ↓')

  return (
    <section className="space-y-4">
      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Active" value={stats.total.toString()} hint={updatedAt ? `Updated ${timeAgo(updatedAt)}` : null} />
        <StatTile label="US" value={stats.us.toString()} accent="blue" />
        <StatTile label="LSE" value={stats.lse.toString()} accent="indigo" />
        <StatTile label="Other" value={stats.other.toString()} accent="gray" />
      </div>

      {/* FX / calendar caveat — persistent, collapsible */}
      <div className="rounded border border-amber-900/60 bg-amber-950/30">
        <button
          type="button"
          onClick={() => setCaveatOpen((o) => !o)}
          className="flex w-full items-center justify-between px-4 py-2 text-left text-xs text-amber-200"
        >
          <span className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wide text-amber-400">caveat</span>
            <span>FX contamination &amp; calendar offset apply to backtests under this universe</span>
          </span>
          <span className="text-amber-400">{caveatOpen ? '−' : '+'}</span>
        </button>
        {caveatOpen && (
          <div className="space-y-1.5 border-t border-amber-900/60 px-4 py-3 text-xs text-amber-100/80">
            <p>
              <strong>FX:</strong> US tickers quote in USD, LSE in GBP/GBX. Returns aren&apos;t
              translated, so a GBP/USD swing inflates Momentum and partly drives the TDA correlation
              distance. ValidationReports under this universe carry the bias.
            </p>
            <p>
              <strong>Calendar:</strong> LSE closes 16:30 GMT, NYSE 21:00 GMT. EOD bars cover
              different wall-clock windows. Factor t-stats are noisier than a single-market run.
            </p>
            <p className="text-amber-300/60">
              Required fix before <code className="text-amber-200">topology_v1</code> go-live: GBP-translation in market-data. Tracked.
            </p>
          </div>
        )}
      </div>

      {/* Ranked table */}
      <div className="rounded border border-gray-800 bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-2">
          <h2 className="text-sm font-medium text-gray-300">
            Active universe <span className="text-gray-500">({sorted.length})</span>
          </h2>
          <div className="flex gap-1 text-[10px]">
            {(['ALL', 'US', 'LSE', 'OTHER'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setFilter(m)}
                className={`rounded px-2 py-1 transition-colors ${
                  filter === m
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="max-h-[480px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-900 text-gray-500 shadow-[inset_0_-1px_0_rgb(31,41,55)]">
              <tr>
                <SortableTh label={`Ticker${indicator('ticker')}`} onClick={() => toggleSort('ticker')} />
                <th className="px-3 py-2 text-left font-normal">Name</th>
                <SortableTh label={`Market${indicator('market')}`} onClick={() => toggleSort('market')} />
                <SortableTh label={`Sector${indicator('sector')}`} onClick={() => toggleSort('sector')} />
                <SortableTh label={`ADV 5d${indicator('adv')}`} onClick={() => toggleSort('adv')} alignRight />
              </tr>
            </thead>
            <tbody>
              {sorted.map((i) => {
                const pct = maxAdv > 0 ? Math.min(1, i.adv / maxAdv) : 0
                const accent = MARKET_STYLES[i.market].border
                return (
                  <tr key={i.ticker} className={`border-b border-gray-800/50 border-l-2 ${accent}`}>
                    <td className="px-3 py-1.5 font-mono text-gray-200">{i.ticker}</td>
                    <td className="px-3 py-1.5 text-gray-400" title={i.name}>{truncate(i.name, 32)}</td>
                    <td className="px-3 py-1.5"><MarketBadge market={i.market} /></td>
                    <td className="px-3 py-1.5 text-gray-400">{i.sector}</td>
                    <td className="px-3 py-1.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="font-mono text-gray-300">{fmtADV(i.adv)}</span>
                        <div className="h-1.5 w-16 overflow-hidden rounded bg-gray-800">
                          <div
                            className="h-full bg-gray-500"
                            style={{ width: `${(pct * 100).toFixed(0)}%` }}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {sorted.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">No instruments match the filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function StatTile({
  label, value, hint, accent,
}: { label: string; value: string; hint?: string | null; accent?: 'blue' | 'indigo' | 'gray' }) {
  const accentText = accent === 'blue' ? 'text-blue-300'
    : accent === 'indigo' ? 'text-indigo-300'
    : accent === 'gray' ? 'text-gray-300'
    : 'text-white'
  return (
    <div className="rounded border border-gray-800 bg-gray-900 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 font-mono text-2xl ${accentText}`}>{value}</div>
      {hint && <div className="mt-1 text-[10px] text-gray-500">{hint}</div>}
    </div>
  )
}

function SortableTh({
  label, onClick, alignRight,
}: { label: string; onClick: () => void; alignRight?: boolean }) {
  return (
    <th className={`px-3 py-2 font-normal ${alignRight ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        onClick={onClick}
        className="text-gray-400 hover:text-gray-200"
      >
        {label}
      </button>
    </th>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
