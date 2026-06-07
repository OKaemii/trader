'use client'
import { useEffect, useState } from 'react'
import { type Money, formatMoney } from '@/types/trader'
import { Hero } from '@/components/layout/Hero'

// The Workspace home hero (Task 19): ONE Portfolio-Overview block — equity curve + PnL + current
// exposure — that the rest of the page is visually subordinate to. It supersedes the old
// PortfolioHero on this page by folding the same cash figures (value / invested / available) into a
// larger, equity-curve-led layout. Built on the generic <Hero> shell so the focus chrome (depth,
// contrast, size) is shared with T31's MarketNarrative and other future heroes.
//
// SSR-seeded twice so the hero paints fully on first byte:
//   - `cash`   ← /admin/api/trading/cash       (value, invested, available; polled 30s)
//   - `equity` ← /admin/api/trading/equity     (NAV series + realised KPIs; demo/live only)
// Both degrade independently: paper mode (or a 400/null equity) drops to a cash-only hero rather
// than fabricating a curve. SAFETY: P&L and portfolio value render in BOTH Beginner and Quant modes
// — this hero is never wrapped in <QuantOnly>.

interface CashState {
  free?: Money
  total?: Money
  mode?: 'Paper' | 'Demo' | 'Live'
  error?: string
}

// Mirror of trading-service /admin/api/trading/equity (computeEquityKpis) — only the fields the
// hero reads. Kept local per the "don't import service-internal types into client components" rule;
// EquityView carries the fuller mirror.
interface NavPoint {
  t: number
  nav: number
}
interface EquityKpis {
  current: number
  totalReturnPct: number
  currentDrawdownPct: number
  nSnapshots: number
}
export interface EquityHeroPayload {
  series: NavPoint[]
  kpis: EquityKpis
  days: number
}

const modeChip = (mode?: string): string =>
  mode === 'Live'
    ? 'bg-red-600 text-white'
    : mode === 'Demo'
      ? 'bg-amber-600 text-white'
      : 'bg-gray-700 text-gray-200'

const fmtPct = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`

// Equity sparkline scoped to the hero — a wider, hero-weight curve distinct from EquityView's
// (which carries axis labels + a range toggle on the Performance tab). Hierarchy via size: this is
// the largest element on the page.
function HeroSparkline({ series }: { series: NavPoint[] }) {
  if (series.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-gray-800 bg-gray-950 text-sm text-gray-500">
        Not enough NAV snapshots yet — the ledger fills ~every 4h.
      </div>
    )
  }
  const W = 900
  const H = 160
  const pad = 6
  const navs = series.map((p) => p.nav)
  const min = Math.min(...navs)
  const max = Math.max(...navs)
  const span = max - min || 1
  const x = (i: number) => pad + (i / (series.length - 1)) * (W - 2 * pad)
  const y = (v: number) => pad + (1 - (v - min) / span) * (H - 2 * pad)
  const line = series.map((p, i) => `${x(i).toFixed(1)},${y(p.nav).toFixed(1)}`).join(' ')
  const up = navs[navs.length - 1]! >= navs[0]!
  const stroke = up ? '#34d399' : '#f87171'
  // Closed area under the curve for the depth/contrast cue.
  const area = `${pad.toFixed(1)},${(H - pad).toFixed(1)} ${line} ${(W - pad).toFixed(1)},${(H - pad).toFixed(1)}`
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950 p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label="Portfolio equity curve">
        <polygon points={area} fill={stroke} fillOpacity={0.08} />
        <polyline points={line} fill="none" stroke={stroke} strokeWidth={1.75} />
      </svg>
    </div>
  )
}

export function PortfolioOverviewHero({
  cash: cashInitial = null,
  equity: equityInitial = null,
}: {
  cash?: CashState | null
  equity?: EquityHeroPayload | null
}) {
  const [cash, setCash] = useState<CashState | null>(cashInitial)
  const [equity, setEquity] = useState<EquityHeroPayload | null>(equityInitial)

  // Poll cash on the same 30s cadence as the old hero. Equity moves ~every 4h, so a poll here would
  // be wasteful; the Performance tab owns the interactive/range-able equity view. We re-fetch equity
  // once on mount only when it wasn't SSR-seeded (e.g. a transient upstream miss).
  useEffect(() => {
    let cancelled = false
    const loadCash = () =>
      fetch('/portal-api/admin/trading/cash')
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setCash(d)
        })
        .catch(() => {})
    if (cashInitial === null) loadCash()
    const id = setInterval(loadCash, 30_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [cashInitial])

  useEffect(() => {
    if (equityInitial !== null) return
    // Paper mode has no broker NAV — upstream 400s — so don't spend a request on it.
    if (cashInitial?.mode === 'Paper') return
    let cancelled = false
    fetch('/portal-api/admin/trading/equity?days=90')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && d.kpis) setEquity(d)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [equityInitial, cashInitial?.mode])

  const isPaper = cash?.mode === 'Paper'
  const total = cash?.total
  const free = cash?.free
  const invested: Money | undefined =
    total && free && total.currency === free.currency
      ? { amount: Math.max(0, total.amount - free.amount), currency: total.currency }
      : undefined
  const investedPct =
    total && invested && total.amount > 0
      ? Math.round((invested.amount / total.amount) * 100)
      : null

  const k = equity?.kpis
  const hasCurve = !isPaper && equity != null && equity.series.length >= 2
  const ret = k?.totalReturnPct
  const dd = k?.currentDrawdownPct

  return (
    <Hero
      eyebrow="Portfolio overview"
      title={
        <div className="font-mono text-4xl font-semibold tabular-nums text-white">
          {isPaper ? '—' : formatMoney(total)}
        </div>
      }
      aside={
        cash?.mode ? (
          <span
            className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wide ${modeChip(cash.mode)}`}
          >
            {cash.mode}
          </span>
        ) : null
      }
    >
      {cash?.error ? (
        <p className="text-sm text-red-400">{cash.error}</p>
      ) : isPaper ? (
        <p className="text-xs text-gray-500">
          Paper mode — no broker account to value. Switch to Demo/Live to see your portfolio and
          equity curve.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[3fr_2fr]">
          {/* Focus: the equity curve dominates by size. */}
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wide text-gray-500">
                Equity curve{equity ? ` · ${equity.days}d` : ''}
              </span>
              {hasCurve && k && (
                <span className="text-[10px] text-gray-600">{k.nSnapshots} snapshots</span>
              )}
            </div>
            <HeroSparkline series={equity?.series ?? []} />
          </div>

          {/* Subordinate: PnL + exposure figures, mono/tabular numerals. */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 self-center">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500">P&amp;L (period)</div>
              <div
                className={`mt-0.5 font-mono text-2xl font-semibold tabular-nums ${
                  ret == null ? 'text-gray-400' : ret >= 0 ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {ret == null ? '—' : fmtPct(ret)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Current drawdown</div>
              <div
                className={`mt-0.5 font-mono text-2xl font-semibold tabular-nums ${
                  dd == null ? 'text-gray-400' : dd < 0 ? 'text-amber-300' : 'text-gray-200'
                }`}
              >
                {dd == null ? '—' : fmtPct(dd)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Invested</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-gray-100">
                {formatMoney(invested)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Available cash</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-emerald-400">
                {formatMoney(free)}
              </div>
            </div>
            {investedPct !== null && (
              <div className="col-span-2">
                <div className="h-1.5 w-full overflow-hidden rounded bg-gray-800">
                  <div className="h-full bg-emerald-500/70" style={{ width: `${investedPct}%` }} />
                </div>
                <div className="mt-1 text-[10px] text-gray-500">
                  {investedPct}% invested · {100 - investedPct}% cash
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Hero>
  )
}
