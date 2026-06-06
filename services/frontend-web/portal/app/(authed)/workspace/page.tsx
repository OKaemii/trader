import { authedFetch } from '@/app/lib/auth-fetch'
import { summariseRecentResearch, type ResearchResultRow } from '@/app/lib/research-summary'
import { PortfolioHero } from '@/components/PortfolioHero'
import { EarningsWarning } from '@/components/EarningsWarning'
import { HoldingsPanel, type HoldingsInitial } from '@/components/HoldingsPanel'
import { SignalFeed } from '@/components/SignalFeed'
import { RecentResearchCard } from '@/components/RecentResearchCard'
import { AutoApproveToggle } from '@/components/AutoApproveToggle'
import { CircuitBreakerCard } from '@/components/CircuitBreakerCard'
import { MarketStateBadge, type MarketState } from '@/components/MarketStateBadge'
import type { SignalProgressDTO } from '@/types/trader'

// Workspace home — the command center. This is the post-login landing page (the old /dashboard,
// which now redirects here). It is a sectioned grid of the existing dashboard cards, NOT a tabbed
// workspace (the ?tab= WorkspaceShell pattern is for the other five workspaces). It SSR-seeds every
// panel exactly as dashboard/page.tsx did so the page paints fully populated on first byte:
//   Portfolio Summary  → PortfolioHero          (/admin/api/trading/cash)
//   Open Positions     → HoldingsPanel          (positions + universe overrides + signals progress)
//   Active Signals     → SignalFeed snapshot     (/api/signals/progress)
//   Today's Events     → EarningsWarning         (self-fetching; renders nothing when clear)
//   Recent Research    → RecentResearchCard      (/admin/api/backtest/results?limit=5)
//   Always-on ops      → CircuitBreakerCard + AutoApproveToggle + MarketStateBadge (+ system health)
// (No Watchlists section — research found no backend for it and this epic is frontend-only.)

// Subset of market-data /health used by the top-bar session badges.
interface MarketDataHealth {
  session_states?: Partial<Record<'US' | 'LSE', MarketState>>
  next_session_open_ts?: number | null
}

interface HealthRow {
  name: string
  ok: boolean
  status?: number
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

interface CashInitial {
  free?: unknown
  total?: unknown
  mode?: 'Paper' | 'Demo' | 'Live'
  error?: string
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

// SSR all three holdings-related endpoints in parallel. With this seed the panel paints real
// positions, sector pie, and held-signals strip on first byte instead of waiting for client
// hydration → 3 sequential fetches. (Mirrors dashboard/page.tsx's fetchHoldingsInitial.)
async function fetchHoldingsInitial(): Promise<HoldingsInitial> {
  const [positions, universe, signalsBody] = await Promise.all([
    fetchJsonOrNull<HoldingsInitial['positions']>('/admin/api/trading/positions'),
    fetchJsonOrNull<HoldingsInitial['universe']>('/admin/api/universe/overrides'),
    fetchJsonOrNull<{ signals?: NonNullable<HoldingsInitial['signals']> }>('/api/signals/progress'),
  ])
  return { positions, universe, signals: signalsBody?.signals ?? [] }
}

// Latest validation/backtest verdicts for the Recent Research snapshot. Returns null on a failed
// fetch (so the card can say "endpoint unavailable" vs. "no runs"); the helper caps to 5 newest.
async function fetchRecentResearch(): Promise<ReturnType<typeof summariseRecentResearch> | null> {
  const body = await fetchJsonOrNull<{ results?: ResearchResultRow[] }>(
    '/admin/api/backtest/results?limit=5',
  )
  if (body === null) return null
  return summariseRecentResearch(body.results ?? [], 5)
}

export default async function WorkspacePage() {
  const [mdHealth, autoApprove, holdings, cash, riskStatus, signalsBody, health, research] =
    await Promise.all([
      fetchJsonOrNull<MarketDataHealth>('/admin/api/market-data/health'),
      fetchJsonOrNull<{ enabled?: boolean }>('/admin/api/signals/auto-approve').then((d) =>
        d ? !!d.enabled : null,
      ),
      fetchHoldingsInitial(),
      fetchJsonOrNull<CashInitial>('/admin/api/trading/cash'),
      fetchJsonOrNull<RiskStatusInitial>('/admin/api/signals/risk/status'),
      fetchJsonOrNull<{ signals?: SignalProgressDTO[] }>('/api/signals/progress'),
      fetchJsonOrNull<HealthRow[]>('/api/admin/system/health'),
      fetchRecentResearch(),
    ])

  const nextOpen = mdHealth?.next_session_open_ts
    ? new Date(mdHealth.next_session_open_ts).toUTCString()
    : null
  const healthDown = (health ?? []).filter((s) => !s.ok)

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">Workspace</h1>
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

      {/* Today's Events — surfaces any open position reporting earnings within 10 days (the swing-
          trade landmine). Renders nothing when clear, so it sits above the grid without reserving space. */}
      <EarningsWarning />

      {/* Portfolio Summary first (Trading212-style): lead with value, not ops controls. */}
      <PortfolioHero initial={cash as never} />

      {/* Primary grid: Open Positions beside the at-a-glance ops controls. */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <section className="space-y-3 xl:col-span-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Open Positions</h2>
          <HoldingsPanel initial={holdings} />
        </section>

        {/* Always-visible operations — the command center's standing controls. */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Operations</h2>
          <CircuitBreakerCard initial={riskStatus} />
          <AutoApproveToggle initialEnabled={autoApprove} />
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
                  <li
                    key={s.name}
                    className="flex items-center justify-between rounded bg-gray-950 px-3 py-1.5 text-sm"
                  >
                    <span className="text-gray-300">{s.name}</span>
                    <span className="text-red-400">down{s.status ? ` (${s.status})` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* Secondary grid: Active Signals beside Recent Research. */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Active Signals</h2>
          </div>
          <SignalFeed initial={signalsBody?.signals ?? null} />
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Research</h2>
          <RecentResearchCard rows={research} />
        </section>
      </div>
    </div>
  )
}
