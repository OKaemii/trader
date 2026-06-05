import { authedFetch } from '@/app/lib/auth-fetch'
import { PortfolioHero } from '@/components/PortfolioHero'
import { EarningsWarning } from '@/components/EarningsWarning'
import { HoldingsPanel, type HoldingsInitial } from '@/components/HoldingsPanel'
import { AutoApproveToggle } from '@/components/AutoApproveToggle'
import { CircuitBreakerCard } from '@/components/CircuitBreakerCard'
import { DangerZone } from '@/components/DangerZone'
import { MarketStateBadge, type MarketState } from '@/components/MarketStateBadge'

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

// Subset of market-data /health used by the top-bar session badges.
interface MarketDataHealth {
  session_states?: Partial<Record<'US' | 'LSE', MarketState>>
  next_session_open_ts?: number | null
}

async function fetchMarketDataHealth(): Promise<MarketDataHealth | null> {
  try {
    const r = await authedFetch('/admin/api/market-data/health')
    if (!r.ok) return null
    return (await r.json()) as MarketDataHealth
  } catch {
    return null
  }
}

// SSR-fetch the auto-approve state so the toggle renders in the correct position on
// first paint — eliminates the on-mount-GET flicker that previously had the slider
// start OFF and animate to ON after a few hundred ms.
async function fetchAutoApprove(): Promise<boolean | null> {
  try {
    const r = await authedFetch('/admin/api/signals/auto-approve')
    if (!r.ok) return null
    const d = (await r.json()) as { enabled?: boolean }
    return !!d.enabled
  } catch {
    return null
  }
}

interface RiskStatusInitial {
  circuit_open: boolean
  circuit_reason: string | null
  nav: number
  hwm: number
  daily_loss_pct: number
  drawdown_from_hwm_pct: number
  rejections_today: number
}
async function fetchRiskStatus(): Promise<RiskStatusInitial | null> {
  try {
    const r = await authedFetch('/admin/api/signals/risk/status')
    if (!r.ok) return null
    return (await r.json()) as RiskStatusInitial
  } catch {
    return null
  }
}

async function fetchJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const r = await authedFetch(path)
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

// SSR all three holdings-related endpoints in parallel. With this seed the panel paints
// real positions, sector pie, and held-signals strip on first byte instead of waiting
// for client hydration → 3 sequential fetches.
async function fetchHoldingsInitial(): Promise<HoldingsInitial> {
  const [positions, universe, signalsBody] = await Promise.all([
    fetchJsonOrNull<HoldingsInitial['positions']>('/admin/api/trading/positions'),
    fetchJsonOrNull<HoldingsInitial['universe']>('/admin/api/universe/overrides'),
    fetchJsonOrNull<{ signals?: NonNullable<HoldingsInitial['signals']> }>('/api/signals/progress'),
  ])
  return { positions, universe, signals: signalsBody?.signals ?? [] }
}

interface CashInitial { free?: unknown; total?: unknown; mode?: 'Paper' | 'Demo' | 'Live'; error?: string }
async function fetchCashInitial(): Promise<CashInitial | null> {
  return fetchJsonOrNull<CashInitial>('/admin/api/trading/cash')
}

export default async function DashboardPage() {
  const [health, mdHealth, autoApprove, holdings, cash, riskStatus] = await Promise.all([
    fetchHealth(),
    fetchMarketDataHealth(),
    fetchAutoApprove(),
    fetchHoldingsInitial(),
    fetchCashInitial(),
    fetchRiskStatus(),
  ])
  const nextOpen = mdHealth?.next_session_open_ts
    ? new Date(mdHealth.next_session_open_ts).toUTCString()
    : null
  const healthDown = (health ?? []).filter((s) => !s.ok)
  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        {mdHealth?.session_states && (
          <div className="flex items-center gap-2">
            {(['US', 'LSE'] as const).map((m) => {
              const state = mdHealth.session_states?.[m]
              if (!state) return null
              return <MarketStateBadge key={m} market={m} state={state} nextOpen={nextOpen} />
            })}
          </div>
        )}
      </div>

      {/* Surfaces any open position reporting earnings within 10 days — the swing-trade landmine. */}
      <EarningsWarning />

      {/* Portfolio first (Trading212-style): lead with value + holdings, not ops controls. */}
      <PortfolioHero initial={cash as never} />

      <section>
        <HoldingsPanel initial={holdings} />
      </section>

      {/* Operations — secondary. Full controls live on the Console; these are the at-a-glance ones. */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Operations</h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <AutoApproveToggle initialEnabled={autoApprove} />
          <CircuitBreakerCard initial={riskStatus} />
          <div className="rounded border border-gray-800 bg-gray-900 p-4">
            <h2 className="mb-2 text-sm font-medium text-gray-300">System health</h2>
            {health === null ? (
              <div className="text-sm text-gray-500">Health endpoint unavailable (admin role required).</div>
            ) : healthDown.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-emerald-400">
                <span>●</span> All {health.length} services healthy
              </div>
            ) : (
              <ul className="space-y-1">
                {healthDown.map((s) => (
                  <li key={s.name} className="flex items-center justify-between rounded bg-gray-950 px-3 py-1.5 text-sm">
                    <span className="text-gray-300">{s.name}</span>
                    <span className="text-red-400">down{s.status ? ` (${s.status})` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <DangerZone />
    </div>
  )
}
