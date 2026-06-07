import { authedFetch } from '@/app/lib/auth-fetch'
import { getSystemHealth } from '@/app/lib/system-health'
import { summariseRecentResearch, type ResearchResultRow } from '@/app/lib/research-summary'
import { ThreeCol } from '@/components/layout/ThreeCol'
import {
  PortfolioOverviewHero,
  type EquityHeroPayload,
} from '@/components/layout/PortfolioOverviewHero'
import { EarningsWarning } from '@/components/EarningsWarning'
import { HoldingsPanel, type HoldingsInitial } from '@/components/HoldingsPanel'
import { SignalFeed } from '@/components/SignalFeed'
import { RecentResearchCard } from '@/components/RecentResearchCard'
import { AutoApproveToggle } from '@/components/AutoApproveToggle'
import { CircuitBreakerCard } from '@/components/CircuitBreakerCard'
import { MarketStateBadge, type MarketState } from '@/components/MarketStateBadge'
import { MarketNarrative, type NarrativePayload } from '@/components/MarketNarrative'
import type { SignalProgressDTO } from '@/types/trader'

// Workspace home — the command center. This is the post-login landing page (the old /dashboard,
// which now redirects here). It is NOT a tabbed workspace (the ?tab= WorkspaceShell pattern is for
// the other five workspaces); it leads with ONE Portfolio-Overview hero and demotes the rest into a
// clearly subordinate rail (Task 19, plan §C). Hierarchy is by size · contrast · depth: the hero is
// the largest, most-elevated block; the supporting cards sit in the flat ThreeCol rail beneath it.
// It SSR-seeds every panel so the page paints fully populated on first byte:
//   Portfolio Overview → PortfolioOverviewHero    (/admin/api/trading/cash + /admin/api/trading/equity)
//   Open Positions     → HoldingsPanel            (positions + universe overrides + signals progress)
//   Active Signals     → SignalFeed snapshot      (/api/signals/progress)
//   Today's Events     → EarningsWarning          (self-fetching; renders nothing when clear)
//   Recent Research    → RecentResearchCard       (/admin/api/backtest/results?limit=5)
//   Always-on ops      → CircuitBreakerCard + AutoApproveToggle + MarketStateBadge (+ system health)
// (No Watchlists section — research found no backend for it and this epic is frontend-only.)
//
// SAFETY (AGENTS.md hard rule): the hero P&L, positions, circuit breaker, kill/pause controls, and
// system health stay visible in BOTH Beginner and Quant modes — nothing on this page is gated by
// <QuantOnly>. Only advanced/quant-only panels elsewhere are.
//
// MARKET-CONTEXT RAIL (T31): the ThreeCol below mounts <MarketNarrative> as its LEFT rail — the
// data-grounded "Today's Market" prose (GET /admin/api/market/narrative, SSR-seeded here so it paints
// populated). It sits beside the hero/positions; the layout already collapsed an empty left track, so
// filling it added the rail without reflowing the center/right columns (the T19 seam).

// Subset of market-data /health used by the top-bar session badges.
interface MarketDataHealth {
  session_states?: Partial<Record<'US' | 'LSE', MarketState>>
  next_session_open_ts?: number | null
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
  // One flat parallel batch — every panel's seed fetched once. `/api/signals/progress` feeds BOTH
  // the HoldingsPanel held-signals strip and the SignalFeed snapshot, so it is fetched a single time
  // here and shared (the dashboard fetched it once for holdings; adding SignalFeed must not double it).
  const [
    mdHealth,
    autoApprove,
    positions,
    universe,
    cash,
    equity,
    riskStatus,
    signalsBody,
    health,
    research,
    narrative,
  ] = await Promise.all([
    fetchJsonOrNull<MarketDataHealth>('/admin/api/market-data/health'),
    fetchJsonOrNull<{ enabled?: boolean }>('/admin/api/signals/auto-approve').then((d) =>
      d ? !!d.enabled : null,
    ),
    fetchJsonOrNull<HoldingsInitial['positions']>('/admin/api/trading/positions'),
    // Routed prefix is /admin/api/market-data/* (no bare /admin/api/universe/*). This is the same
    // upstream the client poll + Discover's getUniverseOverrides() use; the response carries
    // `sectorMap` (HoldingsInitial['universe']), so the Open-Positions sector pie SSR-seeds here.
    fetchJsonOrNull<HoldingsInitial['universe']>('/admin/api/market-data/universe/overrides'),
    fetchJsonOrNull<CashInitial>('/admin/api/trading/cash'),
    // Equity curve + realised KPIs for the hero. Demo/live only — paper mode 400s upstream, so this
    // resolves null and the hero drops to a cash-only view (no fabricated curve).
    fetchJsonOrNull<EquityHeroPayload>('/admin/api/trading/equity?days=90'),
    fetchJsonOrNull<RiskStatusInitial>('/admin/api/signals/risk/status'),
    fetchJsonOrNull<{ signals?: SignalProgressDTO[] }>('/api/signals/progress'),
    // Server components can't fetch their own /portal-api/* route (no origin) — call the
    // shared fan-out directly. Always resolves to HealthRow[] (down service ⇒ ok:false row).
    getSystemHealth(),
    fetchRecentResearch(),
    // "Today's Market" narrative for the left rail. Cached per-UTC-day upstream, so this seed is
    // cheap; null on any failure ⇒ the panel self-fetches on mount (the component handles both).
    fetchJsonOrNull<NarrativePayload>('/admin/api/market/narrative'),
  ])

  const signals = signalsBody?.signals ?? null
  // HoldingsPanel wants [] (not null) for its held-signals strip; SignalFeed wants null to mean
  // "not seeded, fetch on mount" vs [] "seeded empty".
  const holdings: HoldingsInitial = { positions, universe, signals: signals ?? [] }
  const nextOpen = mdHealth?.next_session_open_ts
    ? new Date(mdHealth.next_session_open_ts).toUTCString()
    : null
  const healthDown = health.filter((s) => !s.ok)

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
          trade landmine). Renders nothing when clear, so it sits above the hero without reserving space. */}
      <EarningsWarning />

      {/* THE hero — equity curve + P&L + exposure. Leads the page; everything below is subordinate. */}
      <PortfolioOverviewHero cash={cash as never} equity={equity} />

      {/* Subordinate rail: positions take the center (the most-watched supporting surface); the
          right rail stacks the at-a-glance ops controls, active signals, and recent research as
          flat, lower-contrast cards. The LEFT rail carries the MarketNarrative market-context prose. */}
      <ThreeCol
        centerSpan={2}
        left={
          // SSR-seeded when the fetch succeeded; on a null seed pass `undefined` so the panel
          // self-fetches on mount (its contract: a non-null `initial` skips the client fetch).
          <MarketNarrative initial={narrative ?? undefined} />
        }
        center={
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Open Positions
            </h2>
            <HoldingsPanel initial={holdings} />

            <h2 className="pt-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Active Signals
            </h2>
            <SignalFeed initial={signals} />
          </section>
        }
        right={
          <div className="space-y-6">
            {/* Always-visible operations — the command center's standing safety controls. Never
                gated by mode. */}
            <section className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Operations
              </h2>
              <CircuitBreakerCard initial={riskStatus} />
              <AutoApproveToggle initialEnabled={autoApprove} />
              <div className="rounded border border-gray-800 bg-gray-900 p-4">
                <h2 className="mb-2 text-sm font-medium text-gray-300">System health</h2>
                {healthDown.length === 0 ? (
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

            <section className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Research
              </h2>
              <RecentResearchCard rows={research} />
            </section>
          </div>
        }
      />
    </div>
  )
}
