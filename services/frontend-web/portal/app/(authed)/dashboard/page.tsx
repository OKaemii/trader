import Link from 'next/link'
import { authedFetch } from '@/app/lib/auth-fetch'
import { CashCard } from '@/components/CashCard'
import { HoldingsPanel } from '@/components/HoldingsPanel'
import { AutoApproveToggle } from '@/components/AutoApproveToggle'
import { DangerZone } from '@/components/DangerZone'

interface HealthRow {
  name: string
  ok: boolean
  status?: number
}

async function fetchHealth(): Promise<HealthRow[] | null> {
  try {
    const r = await authedFetch('/api/admin/system/health')
    if (!r.ok) return null
    return (await r.json()) as HealthRow[]
  } catch {
    return null
  }
}

const cards = [
  { href: '/signals', title: 'Signals', desc: 'Latest strategy signals, regime, factor exposure.' },
  { href: '/research', title: 'Research', desc: 'Run backtests, view validation reports, factor decomposition.' },
  { href: '/universe', title: 'Universe', desc: 'Inspect the active universe and add or exclude tickers.' },
  { href: '/market-data', title: 'Market Data', desc: 'Override bar frequency and polling interval.' },
]

export default async function DashboardPage() {
  const health = await fetchHealth()
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-400">Account state, holdings, and system overview.</p>
      </div>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <CashCard />
        <AutoApproveToggle />
        <div className="rounded border border-gray-800 bg-gray-900 p-4 lg:col-span-2">
          <h2 className="mb-2 text-sm font-medium text-gray-300">System health</h2>
          {health === null ? (
            <div className="text-sm text-gray-500">Health endpoint unavailable (admin role required).</div>
          ) : (
            <ul className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {health.map((s) => (
                <li
                  key={s.name}
                  className="flex items-center justify-between rounded bg-gray-950 px-3 py-2 text-sm"
                >
                  <span className="text-gray-300">{s.name}</span>
                  <span className={s.ok ? 'text-emerald-400' : 'text-red-400'}>
                    {s.ok ? 'ok' : `down${s.status ? ` (${s.status})` : ''}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <HoldingsPanel />
      </section>

      <DangerZone />

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-300">Shortcuts</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          {cards.map((c) => (
            <Link
              key={c.href}
              href={c.href}
              className="block rounded border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-gray-700 hover:bg-gray-800"
            >
              <div className="text-base font-medium text-white">{c.title}</div>
              <div className="mt-1 text-xs text-gray-400">{c.desc}</div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
