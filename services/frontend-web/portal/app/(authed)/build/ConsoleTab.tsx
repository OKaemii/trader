import Link from 'next/link'
import { authedFetch } from '@/app/lib/auth-fetch'
import { PanicControls } from '@/components/PanicControls'

// Quick-links to every operator surface — the console is the single launch point. Hrefs point at
// the new IA workspace routes (the old standalone pages are now redirect stubs).
const HUB_LINKS: ReadonlyArray<{ href: string; title: string; desc: string }> = [
  { href: '/portfolio?tab=performance',    title: 'Performance',        desc: 'Equity curve + realised KPIs + service health.' },
  { href: '/operations?tab=trade-audit',   title: 'Trade Audit',        desc: 'Filterable executed-fills ledger.' },
  { href: '/portfolio?tab=risk-limits',    title: 'Risk Limits',        desc: 'Hot-tune halt thresholds + optimiser caps.' },
  { href: '/portfolio?tab=trips',          title: 'Circuit Trips',      desc: 'Circuit-breaker trip post-mortems.' },
  { href: '/operations?tab=reconciliation', title: 'Reconciliation',    desc: 'System ↔ broker drift findings.' },
  { href: '/operations?tab=tca',           title: 'TCA',                desc: 'Transaction-cost analysis.' },
  { href: '/discover?tab=universe',        title: 'Universe / Scanner', desc: 'Active universe, cap→QMJ funnel, selected basket, feed health.' },
  { href: '/build?tab=strategy',           title: 'Strategy',           desc: 'Active strategy + live params.' },
]

// Console tab (Build workspace, IA-redesign Task 9) — the safety surface (kill switch / pause /
// flatten), the body of the old /operations/console page. SSR-seeds the current control state, then
// the client component mutates + re-reads. PanicControls is SAFETY-CRITICAL and is always visible
// (never gated behind a mode). Rendered only when this tab is active, so this is the only authedFetch
// that runs for the tab.
export async function ConsoleTab() {
  const r = await authedFetch('/admin/api/signals/risk/controls')
  const controls = r.ok ? await r.json() : { killSwitch: false, paused: false }

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-400">Panic controls — global kill switch, strategy pause, and flatten-all.</p>
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
