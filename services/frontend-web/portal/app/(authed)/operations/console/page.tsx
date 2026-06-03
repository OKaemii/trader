import Link from 'next/link'
import { authedFetch } from '@/app/lib/auth-fetch'
import { PanicControls } from './PanicControls'

// Quick-links to every operator surface — the console is the single launch point.
const HUB_LINKS: ReadonlyArray<{ href: string; title: string; desc: string }> = [
  { href: '/operations/performance',    title: 'Performance',     desc: 'Equity curve + realised KPIs + service health.' },
  { href: '/operations/trade-audit',    title: 'Trade Audit',     desc: 'Filterable executed-fills ledger.' },
  { href: '/operations/risk-limits',    title: 'Risk Limits',     desc: 'Hot-tune halt thresholds + optimiser caps.' },
  { href: '/risk/trips',                title: 'Circuit Trips',   desc: 'Circuit-breaker trip post-mortems.' },
  { href: '/operations/reconciliation', title: 'Reconciliation',  desc: 'System ↔ broker drift findings.' },
  { href: '/operations/tca',            title: 'TCA',             desc: 'Transaction-cost analysis.' },
  { href: '/scanner',                   title: 'Scanner / Feeds', desc: 'Universe funnel + QMJ + feed health.' },
  { href: '/strategy-config',           title: 'Strategy',        desc: 'Active strategy + live params.' },
]

// Operations console — the safety surface (kill switch / pause / flatten). SSR-seeds the current
// control state, then the client component mutates + re-reads. Health/KPI/equity widgets are a
// follow-up (Plan C phases G2/G3).
export default async function ConsolePage() {
  const r = await authedFetch('/admin/api/signals/risk/controls')
  const controls = r.ok ? await r.json() : { killSwitch: false, paused: false }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Operations Console</h1>
        <p className="text-sm text-gray-400">Panic controls — global kill switch, strategy pause, and flatten-all.</p>
      </div>
      {!r.ok && (
        <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          {r.status === 401 || r.status === 403 ? 'Admin role required.' : `Controls state unavailable (${r.status}) — actions still work.`}
        </div>
      )}
      <PanicControls initial={controls} />

      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-400">Operator surfaces</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {HUB_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-emerald-700 hover:bg-gray-800"
            >
              <div className="font-semibold text-gray-100">{l.title}</div>
              <div className="mt-1 text-xs text-gray-400">{l.desc}</div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
