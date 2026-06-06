'use client'

import { useMemo, useState } from 'react'
import { MarketBadge } from '@/components/MarketBadge'

// Consolidated Universe ⇆ Scanner view. The EODHD-fed scan IS the universe, so the scanner funnel
// (cap → QMJ quality) and the per-name table live here on the Universe page rather than a separate
// route. Sourced from /admin/api/market-data/scanner/{snapshot,feed-health} + the active pie.

interface Ratios { roe: number; debtToEquity: number; currentRatio: number }
interface Row {
  ticker: string; name: string; market: string; sector: string
  marketCapGbp: number | null; ratios: Ratios | null; qualityPass: boolean | null
}
interface Snapshot { universeSize: number; qualityKnown: number; qualityPassCount: number; rows: Row[] }
interface Health {
  eodhd: { callsUsedToday: number; dailyCallLimit: number }
  fundamentals: { count: number; passing: number; oldestAsOf: number | null }
  feed: { date: string; usPulledToday: boolean; lsePulledToday: boolean }
  config: { universeSource: string; dailyHistoryProvider: string; fundamentalsProvider: string; minMarketCapGbp: number }
}
interface PieTarget { ticker: string; targetWeight: number }
interface Pie { pieId: string; name: string; status: string; updatedAt: number; targets: PieTarget[] }

const fmtCap = (v: number | null): string =>
  v == null ? '—' : v >= 1e9 ? `£${(v / 1e9).toFixed(1)}B` : `£${(v / 1e6).toFixed(0)}M`
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`
const QMJ_TITLE = 'QMJ quality screen (fail-closed): ROE ≥ 10% ∧ Debt/Equity ≤ 2.0 ∧ Current ratio ≥ 1.0'

type MarketFilter = 'ALL' | 'US' | 'LSE'
type SortKey = 'cap' | 'ticker' | 'sector' | 'roe'

export function ScannerPanel({
  initialSnapshot, initialHealth, initialPie,
}: { initialSnapshot: Snapshot; initialHealth: Health | null; initialPie: Pie | null }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot)
  const [health, setHealth] = useState<Health | null>(initialHealth)
  const [busy, setBusy] = useState<'scan' | 'fund' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [filter, setFilter] = useState<MarketFilter>('ALL')
  const [sortBy, setSortBy] = useState<SortKey>('cap')

  async function refresh(): Promise<Snapshot> {
    const [s, h] = await Promise.all([
      fetch('/portal-api/admin/scanner/snapshot').then((r) => r.json()),
      fetch('/portal-api/admin/scanner/feed-health').then((r) => r.json()).catch(() => null),
    ])
    setSnapshot(s)
    if (h) setHealth(h)
    return s
  }

  async function runScan(): Promise<void> {
    if (!window.confirm('Re-run the EODHD market scan and rebuild the active universe? This calls the EODHD screener (uses API credits) and replaces the universe with the current ≥£5B US+UK set, market-balanced ~100 US / 100 UK.')) return
    setBusy('scan'); setErr(null)
    try {
      const r = await fetch('/portal-api/admin/scanner/run', { method: 'POST' })
      if (!r.ok) throw new Error(`scan failed (${r.status})`)
      await refresh()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
  }

  async function refreshFundamentals(): Promise<void> {
    if (!window.confirm('Refresh fundamentals (ROE / D-E / current ratio + market cap) for the active universe?\n\nThis runs in the background and is paced to stay under the provider’s rate limit, so the table fills in gradually over a few minutes.')) return
    setBusy('fund'); setErr(null); setNote(null)
    try {
      const r = await fetch('/portal-api/admin/scanner/fundamentals-refresh', { method: 'POST' })
      if (!r.ok) throw new Error(`fundamentals refresh failed (${r.status})`)
      setNote('Refresh started in the background — fundamentals are populating. This table updates as names land.')
      // The refresh is non-blocking + paced, so coverage grows gradually. Poll the snapshot for
      // progress (~2min) and stop early once every name has quality data.
      for (let i = 0; i < 24; i++) {
        await new Promise((res) => setTimeout(res, 5000))
        const s = await refresh()
        if (s.qualityKnown >= s.universeSize && s.universeSize > 0) {
          setNote(`Fundamentals populated — ${s.qualityKnown}/${s.universeSize} names have quality data.`)
          return
        }
        setNote(`Populating fundamentals… ${s.qualityKnown}/${s.universeSize} names so far (continues in the background).`)
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
  }

  const usCount  = useMemo(() => snapshot.rows.filter((r) => r.market === 'US').length, [snapshot.rows])
  const lseCount = useMemo(() => snapshot.rows.filter((r) => r.market === 'LSE').length, [snapshot.rows])
  const qualityFail = Math.max(0, snapshot.qualityKnown - snapshot.qualityPassCount)
  const pieTickers = useMemo(() => new Set((initialPie?.targets ?? []).map((t) => t.ticker)), [initialPie])

  const rows = useMemo(() => {
    const filtered = filter === 'ALL' ? snapshot.rows : snapshot.rows.filter((r) => r.market === filter)
    const cmp = (a: Row, b: Row): number => {
      switch (sortBy) {
        case 'cap':    return (b.marketCapGbp ?? 0) - (a.marketCapGbp ?? 0)
        case 'roe':    return (b.ratios?.roe ?? -Infinity) - (a.ratios?.roe ?? -Infinity)
        case 'ticker': return a.ticker.localeCompare(b.ticker)
        case 'sector': return a.sector.localeCompare(b.sector)
      }
    }
    return [...filtered].sort(cmp)
  }, [snapshot.rows, filter, sortBy])

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Scan &amp; quality funnel</h2>
        <div className="flex gap-2">
          <button onClick={runScan} disabled={busy !== null} className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-100 transition-colors hover:bg-gray-700 disabled:opacity-50">
            {busy === 'scan' ? 'Scanning…' : 'Run scan'}
          </button>
          <button onClick={refreshFundamentals} disabled={busy !== null} className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-100 transition-colors hover:bg-gray-700 disabled:opacity-50">
            {busy === 'fund' ? 'Refreshing…' : 'Refresh fundamentals'}
          </button>
        </div>
      </div>

      {err && <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">{err}</div>}
      {note && <div className="rounded border border-sky-900 bg-sky-950 px-4 py-2 text-sm text-sky-300">{note}</div>}

      {/* Funnel: universe → market split → quality */}
      <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
        <Tile label="Universe" value={snapshot.universeSize} />
        <Tile label="US" value={usCount} accent="blue" />
        <Tile label="UK (LSE)" value={lseCount} accent="indigo" />
        <Tile label="Quality known" value={snapshot.qualityKnown} />
        <Tile label="Quality PASS" value={snapshot.qualityPassCount} accent="emerald" />
        <Tile label="Quality FAIL" value={qualityFail} accent="red" />
      </div>

      {health && (
        <div className="rounded border border-gray-800 bg-gray-900 p-4 text-xs">
          <h3 className="mb-2 font-semibold text-gray-300">Feed health</h3>
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 text-gray-400 md:grid-cols-3">
            <span>EODHD credits today: <span className="text-gray-100">{health.eodhd.callsUsedToday} / {health.eodhd.dailyCallLimit}</span></span>
            <span>Universe source: <span className="text-gray-100">{health.config.universeSource}</span></span>
            <span>Daily provider: <span className="text-gray-100">{health.config.dailyHistoryProvider}</span></span>
            <span>Fundamentals src: <span className="text-gray-100">{health.config.fundamentalsProvider}</span> ({health.fundamentals.count} cached / {health.fundamentals.passing} pass)</span>
            <span>Min market cap: <span className="text-gray-100">{fmtCap(health.config.minMarketCapGbp)}</span></span>
            <span>Bulk EOD {health.feed.date}: US <span className={health.feed.usPulledToday ? 'text-emerald-400' : 'text-amber-300'}>{health.feed.usPulledToday ? '✓' : 'pending'}</span>, LSE <span className={health.feed.lsePulledToday ? 'text-emerald-400' : 'text-amber-300'}>{health.feed.lsePulledToday ? '✓' : 'pending'}</span></span>
          </div>
        </div>
      )}

      {/* What the strategy actually holds — the chosen names + weights */}
      {initialPie && initialPie.targets.length > 0 ? (
        <div className="rounded border border-emerald-900/50 bg-emerald-950/20 p-4 text-sm">
          <h3 className="mb-2 font-semibold text-gray-200">
            Selected holdings — {initialPie.name}
            <span className="ml-2 text-xs font-normal text-gray-500">
              {initialPie.targets.length} names · inverse-vol weighted · updated {new Date(initialPie.updatedAt).toLocaleDateString('en-GB')}
            </span>
          </h3>
          <div className="flex flex-wrap gap-2">
            {[...initialPie.targets].sort((a, b) => b.targetWeight - a.targetWeight).map((t) => (
              <span key={t.ticker} className="rounded bg-gray-800 px-2 py-1 font-mono text-xs text-gray-200">
                {t.ticker} <span className="text-emerald-400">{(t.targetWeight * 100).toFixed(1)}%</span>
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded border border-gray-800 bg-gray-900 p-4 text-xs text-gray-400">
          No selected holdings yet — the chosen basket (12-1 momentum top-20 over the quality-passing
          names) appears here once <code className="text-gray-200">high_velocity_v1</code> is the active strategy and has rebalanced.
        </div>
      )}

      {/* Unified per-name table: replaces the old ADV table (ADV is 0 under eodhd_scan) with cap + QMJ */}
      <div className="rounded border border-gray-800 bg-gray-900">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-800 px-4 py-2">
          <h3 className="text-sm font-medium text-gray-300">Active universe <span className="text-gray-500">({rows.length})</span></h3>
          <div className="flex items-center gap-3 text-[10px]">
            <div className="flex gap-1">
              {(['ALL', 'US', 'LSE'] as const).map((m) => (
                <button key={m} type="button" onClick={() => setFilter(m)}
                  className={`rounded px-2 py-1 transition-colors ${filter === m ? 'bg-gray-700 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}`}>
                  {m === 'LSE' ? 'UK' : m}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1 text-gray-500">
              sort
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)}
                className="rounded border border-gray-700 bg-gray-800 px-1.5 py-1 text-gray-200">
                <option value="cap">Market cap</option>
                <option value="roe">ROE</option>
                <option value="ticker">Ticker</option>
                <option value="sector">Sector</option>
              </select>
            </label>
          </div>
        </div>
        <div className="max-h-[520px] overflow-y-auto overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="sticky top-0 bg-gray-900 text-left text-gray-500 shadow-[inset_0_-1px_0_rgb(31,41,55)]">
              <tr>
                <th className="px-3 py-2 font-normal">Ticker</th>
                <th className="px-3 py-2 font-normal">Name</th>
                <th className="px-3 py-2 font-normal">Mkt</th>
                <th className="px-3 py-2 font-normal">Sector</th>
                <th className="px-3 py-2 text-right font-normal">Mkt cap</th>
                <th className="px-3 py-2 text-right font-normal">ROE</th>
                <th className="px-3 py-2 text-right font-normal">D/E</th>
                <th className="px-3 py-2 text-right font-normal">Curr.</th>
                <th className="px-3 py-2 text-center font-normal" title={QMJ_TITLE}>Quality</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800 text-gray-300">
              {rows.map((r) => {
                const held = pieTickers.has(r.ticker)
                return (
                  <tr key={r.ticker} className={`hover:bg-gray-900/50 ${held ? 'bg-emerald-950/20' : ''}`}>
                    <td className="px-3 py-1.5 font-mono text-gray-100">
                      {held && <span title="In the selected basket" className="mr-1 text-emerald-400">●</span>}{r.ticker}
                    </td>
                    <td className="px-3 py-1.5 text-gray-400" title={r.name}>{truncate(r.name, 30)}</td>
                    <td className="px-3 py-1.5"><MarketBadge market={(r.market === 'US' || r.market === 'LSE') ? r.market : 'OTHER'} /></td>
                    <td className="px-3 py-1.5 text-gray-400">{r.sector}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{fmtCap(r.marketCapGbp)}</td>
                    <td className="px-3 py-1.5 text-right">{r.ratios ? pct(r.ratios.roe) : '—'}</td>
                    <td className="px-3 py-1.5 text-right">{r.ratios ? r.ratios.debtToEquity.toFixed(2) : '—'}</td>
                    <td className="px-3 py-1.5 text-right">{r.ratios ? r.ratios.currentRatio.toFixed(2) : '—'}</td>
                    <td className="px-3 py-1.5 text-center" title={QMJ_TITLE}>
                      {r.qualityPass === null
                        ? <span className="text-gray-600">—</span>
                        : r.qualityPass
                          ? <span className="text-emerald-400">PASS</span>
                          : <span className="text-red-400">FAIL</span>}
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-500">No names match the filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function Tile({ label, value, accent }: { label: string; value: number; accent?: 'emerald' | 'red' | 'blue' | 'indigo' }) {
  const color = accent === 'emerald' ? 'text-emerald-400'
    : accent === 'red' ? 'text-red-400'
    : accent === 'blue' ? 'text-blue-300'
    : accent === 'indigo' ? 'text-indigo-300'
    : 'text-white'
  return (
    <div className="rounded border border-gray-800 bg-gray-900 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 font-mono text-2xl ${color}`}>{value}</div>
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
