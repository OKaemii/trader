import Link from 'next/link'
import { authedFetch } from '@/app/lib/auth-fetch'

interface SignalRow {
  id?: string
  ticker?: string
  action?: string
  lifecycle?: number
  timestamp?: number
  targetWeight?: number
  confidence?: number
  entryPrice?: number
  approvedAt?: number | string | Date
  executedAt?: number | string | Date
  failureReason?: number
  failureDetail?: string
  strategy_id?: string
}

interface RejectionRow {
  timestamp?: number
  reason?: string
  detail?: Record<string, unknown>
}

interface PositionRow {
  ticker?: string
  quantity?: number
  weight?: number
  currentPrice?: { amount?: number; currency?: string }
  currentValue?: { amount?: number; currency?: string }
}

interface TripDoc {
  id: string
  ts: number
  reason: 'DAILY_LOSS_HALT' | 'DRAWDOWN_HALT'
  reasonText: string
  nav: number
  hwm: number
  dayOpenNav: number
  dailyLossPct: number
  drawdownPct: number
  cashSnapshot: { free?: { amount?: number; currency?: string }; total?: { amount?: number; currency?: string } } | null
  positions: PositionRow[]
  recentSignals: SignalRow[]
  recentRejections: RejectionRow[]
  cancelledSignalIds: string[]
  cancelledCount: number
}

// Mirror of @trader/shared-types SignalLifecycle. Kept here because importing the
// service package into a Next.js page tree pulls server-only deps. The numeric values
// match the enum — change here if the enum order ever changes.
const LIFECYCLE_LABEL = ['Pending', 'Approved', 'Queued', 'Executing', 'Executed', 'Closed', 'Failed']

async function fetchTrip(id: string): Promise<TripDoc | null> {
  try {
    const r = await authedFetch(`/admin/api/signals/risk/trips/${encodeURIComponent(id)}`)
    if (!r.ok) return null
    return (await r.json()) as TripDoc
  } catch {
    return null
  }
}

function fmtTs(v: number | string | Date | undefined): string {
  if (v === undefined || v === null) return '—'
  const d = typeof v === 'number' ? new Date(v) : new Date(v as string)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

export default async function TripDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const trip = await fetchTrip(id)

  if (!trip) {
    return (
      <div className="p-6">
        <Link href="/risk/trips" className="text-xs text-gray-400 underline hover:text-gray-200">← back to trips</Link>
        <h1 className="mt-3 text-xl font-bold text-white">Trip not found</h1>
        <p className="mt-1 text-sm text-gray-400">No post-mortem exists for id <code>{id}</code>.</p>
      </div>
    )
  }

  const cancelledSet = new Set(trip.cancelledSignalIds)

  return (
    <div className="space-y-6 p-6">
      <div>
        <Link href="/risk/trips" className="text-xs text-gray-400 underline hover:text-gray-200">← back to trips</Link>
        <h1 className="mt-3 text-2xl font-bold text-white">Trip post-mortem</h1>
        <p className="mt-1 font-mono text-xs text-gray-500">{trip.id}</p>
      </div>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Fact label="When (UTC)" value={fmtTs(trip.ts)} />
        <Fact label="Reason" value={trip.reason} accent={trip.reason === 'DAILY_LOSS_HALT' ? 'amber' : 'red'} />
        <Fact label="Reason text" value={trip.reasonText} />
        <Fact label="NAV" value={`£${trip.nav.toFixed(2)}`} />
        <Fact label="HWM" value={`£${trip.hwm.toFixed(2)}`} />
        <Fact label="Day open NAV" value={`£${trip.dayOpenNav.toFixed(2)}`} />
        <Fact label="Daily loss" value={`${(trip.dailyLossPct * 100).toFixed(2)}%`} />
        <Fact label="Drawdown from HWM" value={`${(trip.drawdownPct * 100).toFixed(2)}%`} />
        <Fact label="Cancelled BUYs" value={String(trip.cancelledCount)} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-300">Account snapshot</h2>
        <div className="rounded border border-gray-800 bg-gray-950 p-3 text-xs">
          {trip.cashSnapshot ? (
            <div className="grid grid-cols-2 gap-2 font-mono">
              <div>
                <span className="text-gray-500">Free cash: </span>
                <span className="text-gray-200">
                  {trip.cashSnapshot.free?.amount?.toFixed(2) ?? '—'} {trip.cashSnapshot.free?.currency ?? ''}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Total: </span>
                <span className="text-gray-200">
                  {trip.cashSnapshot.total?.amount?.toFixed(2) ?? '—'} {trip.cashSnapshot.total?.currency ?? ''}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-gray-500">Cash snapshot was unavailable at trip time.</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-300">Positions at trip ({trip.positions.length})</h2>
        {trip.positions.length === 0 ? (
          <p className="text-xs text-gray-500">No open positions.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-gray-800">
            <table className="min-w-full divide-y divide-gray-800 text-xs">
              <thead className="bg-gray-900 text-left uppercase tracking-wider text-gray-400">
                <tr>
                  <th className="px-3 py-1.5">Ticker</th>
                  <th className="px-3 py-1.5 text-right">Qty</th>
                  <th className="px-3 py-1.5 text-right">Weight</th>
                  <th className="px-3 py-1.5 text-right">Price</th>
                  <th className="px-3 py-1.5 text-right">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800 bg-gray-950 font-mono">
                {trip.positions.map((p, i) => (
                  <tr key={i} className="text-gray-200">
                    <td className="px-3 py-1.5">{p.ticker ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right">{p.quantity?.toFixed(4) ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right">{p.weight != null ? `${(p.weight * 100).toFixed(2)}%` : '—'}</td>
                    <td className="px-3 py-1.5 text-right">
                      {p.currentPrice?.amount?.toFixed(2) ?? '—'} {p.currentPrice?.currency ?? ''}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {p.currentValue?.amount?.toFixed(2) ?? '—'} {p.currentValue?.currency ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-300">
          Recent signals at trip ({trip.recentSignals.length})
          <span className="ml-2 text-[11px] text-gray-500">— rows highlighted in red were cancelled by the auto-drain</span>
        </h2>
        <div className="overflow-x-auto rounded border border-gray-800">
          <table className="min-w-full divide-y divide-gray-800 text-xs">
            <thead className="bg-gray-900 text-left uppercase tracking-wider text-gray-400">
              <tr>
                <th className="px-3 py-1.5">Emitted</th>
                <th className="px-3 py-1.5">Ticker</th>
                <th className="px-3 py-1.5">Action</th>
                <th className="px-3 py-1.5">Lifecycle</th>
                <th className="px-3 py-1.5 text-right">Conf</th>
                <th className="px-3 py-1.5 text-right">Weight</th>
                <th className="px-3 py-1.5">Strategy</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800 bg-gray-950 font-mono">
              {trip.recentSignals.map((s, i) => {
                const wasCancelled = s.id && cancelledSet.has(s.id)
                return (
                  <tr key={i} className={wasCancelled ? 'bg-red-950/30 text-red-200' : 'text-gray-200'}>
                    <td className="px-3 py-1.5">{fmtTs(s.timestamp)}</td>
                    <td className="px-3 py-1.5">{s.ticker ?? '—'}</td>
                    <td className="px-3 py-1.5">{s.action ?? '—'}</td>
                    <td className="px-3 py-1.5">{s.lifecycle != null ? (LIFECYCLE_LABEL[s.lifecycle] ?? `#${s.lifecycle}`) : '—'}</td>
                    <td className="px-3 py-1.5 text-right">{s.confidence?.toFixed(2) ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right">{s.targetWeight != null ? `${(s.targetWeight * 100).toFixed(2)}%` : '—'}</td>
                    <td className="px-3 py-1.5">{s.strategy_id ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-300">Recent rejections ({trip.recentRejections.length})</h2>
        {trip.recentRejections.length === 0 ? (
          <p className="text-xs text-gray-500">No prior risk rejections recorded.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-gray-800">
            <table className="min-w-full divide-y divide-gray-800 text-xs">
              <thead className="bg-gray-900 text-left uppercase tracking-wider text-gray-400">
                <tr>
                  <th className="px-3 py-1.5">When</th>
                  <th className="px-3 py-1.5">Reason</th>
                  <th className="px-3 py-1.5">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800 bg-gray-950 font-mono">
                {trip.recentRejections.map((r, i) => (
                  <tr key={i} className="text-gray-200">
                    <td className="px-3 py-1.5">{fmtTs(r.timestamp)}</td>
                    <td className="px-3 py-1.5">{r.reason ?? '—'}</td>
                    <td className="px-3 py-1.5 text-[11px] text-gray-400">{JSON.stringify(r.detail ?? {})}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function Fact({ label, value, accent }: { label: string; value: string; accent?: 'amber' | 'red' }) {
  const color = accent === 'red' ? 'text-red-300' : accent === 'amber' ? 'text-amber-300' : 'text-gray-100'
  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-3">
      <div className="text-[11px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`mt-1 break-words font-mono text-sm ${color}`}>{value}</div>
    </div>
  )
}
