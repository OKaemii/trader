'use client'

import { useState } from 'react'

interface Ratios { roe: number; debtToEquity: number; currentRatio: number }
interface Row {
  ticker: string; name: string; market: string; sector: string;
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

export function ScannerView({ initialSnapshot, initialHealth, initialPie }: { initialSnapshot: Snapshot; initialHealth: Health | null; initialPie: Pie | null }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot)
  const [health, setHealth] = useState<Health | null>(initialHealth)
  const [busy, setBusy] = useState<'scan' | 'fund' | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    const [s, h] = await Promise.all([
      fetch('/portal-api/admin/scanner/snapshot').then((r) => r.json()),
      fetch('/portal-api/admin/scanner/feed-health').then((r) => r.json()).catch(() => null),
    ])
    setSnapshot(s)
    if (h) setHealth(h)
  }

  async function runScan(): Promise<void> {
    if (!window.confirm('Re-run the EODHD market scan and rebuild the active universe? This calls the EODHD screener (uses API credits) and replaces the universe with the current ≥£5B US+UK set.')) return
    setBusy('scan'); setErr(null)
    try {
      const r = await fetch('/portal-api/admin/scanner/run', { method: 'POST' })
      if (!r.ok) throw new Error(`scan failed (${r.status})`)
      await refresh()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
  }

  async function refreshFundamentals(): Promise<void> {
    if (!window.confirm('Refresh fundamentals (ROE / D-E / current ratio + market cap) for the active universe from Yahoo? ~1 API call per name.')) return
    setBusy('fund'); setErr(null)
    try {
      const r = await fetch('/portal-api/admin/scanner/fundamentals-refresh', { method: 'POST' })
      if (!r.ok) throw new Error(`fundamentals refresh failed (${r.status})`)
      await refresh()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
  }

  const qualityFail = Math.max(0, snapshot.qualityKnown - snapshot.qualityPassCount)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Market Scanner</h1>
          <p className="text-sm text-gray-400">EODHD-fed single universe — market-cap scan, QMJ quality screen, and feed health.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={runScan} disabled={busy !== null} className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-100 transition-colors hover:bg-gray-700 disabled:opacity-50">
            {busy === 'scan' ? 'Scanning…' : 'Run scan'}
          </button>
          <button onClick={refreshFundamentals} disabled={busy !== null} className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-100 transition-colors hover:bg-gray-700 disabled:opacity-50">
            {busy === 'fund' ? 'Refreshing…' : 'Refresh fundamentals'}
          </button>
        </div>
      </header>

      {err && <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">{err}</div>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Tile label="Universe (tradeable)" value={snapshot.universeSize} />
        <Tile label="Quality data known" value={snapshot.qualityKnown} />
        <Tile label="Quality PASS" value={snapshot.qualityPassCount} accent="emerald" />
        <Tile label="Quality FAIL" value={qualityFail} accent="red" />
      </div>

      {health && (
        <div className="rounded border border-gray-800 bg-gray-900 p-4 text-sm">
          <h2 className="mb-2 font-semibold text-gray-200">Feed health</h2>
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

      {initialPie && initialPie.targets.length > 0 && (
        <div className="rounded border border-gray-800 bg-gray-900 p-4 text-sm">
          <h2 className="mb-2 font-semibold text-gray-200">
            Active pie — {initialPie.name}
            <span className="ml-2 text-xs font-normal text-gray-500">
              {initialPie.targets.length} holdings · inverse-vol · updated {new Date(initialPie.updatedAt).toLocaleDateString()}
            </span>
          </h2>
          <div className="flex flex-wrap gap-2">
            {[...initialPie.targets].sort((a, b) => b.targetWeight - a.targetWeight).map((t) => (
              <span key={t.ticker} className="rounded bg-gray-800 px-2 py-1 font-mono text-xs text-gray-200">
                {t.ticker} <span className="text-emerald-400">{(t.targetWeight * 100).toFixed(1)}%</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded border border-gray-800">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-900 text-left text-gray-400">
            <tr>
              <th className="px-3 py-2">Ticker</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Mkt</th>
              <th className="px-3 py-2">Sector</th>
              <th className="px-3 py-2 text-right">Mkt cap</th>
              <th className="px-3 py-2 text-right">ROE</th>
              <th className="px-3 py-2 text-right">D/E</th>
              <th className="px-3 py-2 text-right">Curr.</th>
              <th className="px-3 py-2 text-center">Quality</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800 text-gray-300">
            {snapshot.rows.map((r) => (
              <tr key={r.ticker} className="hover:bg-gray-900/50">
                <td className="px-3 py-1.5 font-mono text-gray-100">{r.ticker}</td>
                <td className="px-3 py-1.5">{r.name}</td>
                <td className="px-3 py-1.5">{r.market}</td>
                <td className="px-3 py-1.5">{r.sector}</td>
                <td className="px-3 py-1.5 text-right">{fmtCap(r.marketCapGbp)}</td>
                <td className="px-3 py-1.5 text-right">{r.ratios ? pct(r.ratios.roe) : '—'}</td>
                <td className="px-3 py-1.5 text-right">{r.ratios ? r.ratios.debtToEquity.toFixed(2) : '—'}</td>
                <td className="px-3 py-1.5 text-right">{r.ratios ? r.ratios.currentRatio.toFixed(2) : '—'}</td>
                <td className="px-3 py-1.5 text-center">
                  {r.qualityPass === null
                    ? <span className="text-gray-600">—</span>
                    : r.qualityPass
                      ? <span className="text-emerald-400">PASS</span>
                      : <span className="text-red-400">FAIL</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Tile({ label, value, accent }: { label: string; value: number; accent?: 'emerald' | 'red' }) {
  const color = accent === 'emerald' ? 'text-emerald-400' : accent === 'red' ? 'text-red-400' : 'text-white'
  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${color}`}>{value}</div>
    </div>
  )
}
