import { authedFetch } from '@/app/lib/auth-fetch'
import { CandlestickChart } from '@/components/CandlestickChart'
import { FactorBars, type FactorScores } from '@/components/FactorBars'
import { MarketBadge } from '@/components/MarketBadge'
import { marketOf } from '@/components/market'
import type { SignalProgressDTO } from '@/types/trader'
import { SignalLifecycle } from '@/types/trader'

// Overview tab — the symbol-workspace landing question-tab (research-trading-os Task 24 §E).
//
// Stack (the shell already renders SymbolHeader above this, so the body starts at the chart):
//   CandlestickChart (reused) → FactorBars (factor percentile bars) → active signals (per-symbol)
//   → strategy exposure → Recent Events (news). Each panel degrades to an honest empty/"—" state
//   when its data isn't available (pre-backfill factor store, no signals, no news) — never a
//   fabricated number.
//
// Async SERVER component: it owns the authedFetch calls and SSR-seeds the client FactorBars so the
// page renders populated on first paint. The strategy-exposure + active-signals + recent-events
// panels are presentational over server-fetched data, inlined here (this card owns only OverviewTab
// + FactorBars + SymbolHeader; the per-symbol Signals tab + its dedicated `by-ticker` endpoint are
// a sibling card — Overview reads the existing progress feed for the lightweight active slice).
//
// PROP CONTRACT (stable; see the T23 scaffold): exactly `{ symbol }` — the in-universe ticker;
// page.tsx guarantees it is non-empty before mounting a tab.

interface RawBar {
  observation_ts?: number
  timestamp?: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** One per-strategy exposure row for a ticker (from /admin/api/signals/strategy-impact?ticker=). */
interface StrategyImpactRow {
  strategyId: string
  currentRank: number | null
  historicalInclusionPct: number
  avgHoldingDays: number
  contributionPct: number
  selected: boolean
}

interface NewsArticle {
  date: string
  title: string
  link: string
  symbols?: string[]
  tags?: string[]
  sentiment?: { polarity: number; neg: number; neu: number; pos: number }
}

const MAX_EVENTS = 8

/** Daily OHLCV for the candlestick chart — same endpoint the History tab seeds from. */
async function fetchBars(symbol: string) {
  const r = await authedFetch(`/admin/api/market-data/bars/${encodeURIComponent(symbol)}?interval=daily&range=1y`)
  const data = r.ok ? await r.json().catch(() => null) : null
  return ((data?.bars ?? []) as RawBar[]).map((b) => ({
    time: Math.floor((b.observation_ts ?? b.timestamp ?? 0) / 1000),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }))
}

/** Server-seed the factor percentile bars (Task 10 scores reader). `{}` ⇒ pre-backfill/unknown,
 *  which FactorBars renders as "not yet computed". A non-ok response degrades to `{}` likewise. */
async function fetchScores(symbol: string): Promise<FactorScores> {
  const r = await authedFetch(`/admin/api/strategy/scores?ticker=${encodeURIComponent(symbol)}`)
  if (!r.ok) return {}
  return (await r.json().catch(() => ({}))) as FactorScores
}

// "Active" = a signal still in the live pipeline (not a terminal Closed/Failed/Cancelled row). The
// panel is labelled "Active signals", so terminal history is excluded here — the per-symbol Signals
// tab (a sibling card) owns the full signal history view.
const TERMINAL_LIFECYCLES = new Set<SignalLifecycle>([
  SignalLifecycle.Closed,
  SignalLifecycle.Failed,
  SignalLifecycle.Cancelled,
])

/** Per-symbol ACTIVE signals filtered from the existing progress feed (no new endpoint). */
async function fetchSymbolSignals(symbol: string): Promise<SignalProgressDTO[]> {
  const r = await authedFetch('/api/signals/progress')
  if (!r.ok) return []
  const data = (await r.json().catch(() => null)) as { signals?: SignalProgressDTO[] } | null
  return (data?.signals ?? []).filter((s) => {
    if (s.ticker !== symbol) return false
    const lifecycle = s.lifecycleResolved ?? s.lifecycle ?? SignalLifecycle.Pending
    return !TERMINAL_LIFECYCLES.has(lifecycle)
  })
}

/** Per-strategy exposure rows for the ticker. Best-effort — degrades to []. */
async function fetchExposure(symbol: string): Promise<StrategyImpactRow[]> {
  const r = await authedFetch(`/admin/api/signals/strategy-impact?ticker=${encodeURIComponent(symbol)}`)
  if (!r.ok) return []
  const data = (await r.json().catch(() => null)) as { strategies?: StrategyImpactRow[] } | null
  return data?.strategies ?? []
}

/** Recent news for the ticker (Task 15). Best-effort — degrades to []. */
async function fetchNews(symbol: string): Promise<NewsArticle[]> {
  const r = await authedFetch(`/admin/api/market-data/news?ticker=${encodeURIComponent(symbol)}`)
  if (!r.ok) return []
  const data = (await r.json().catch(() => null)) as { articles?: NewsArticle[] } | null
  return data?.articles ?? []
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-lg bg-gray-900 p-4">
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      {children}
    </div>
  )
}

function actionBadge(action: SignalProgressDTO['action']) {
  const colour = action === 'BUY' ? 'bg-green-600' : action === 'SELL' ? 'bg-red-600' : 'bg-gray-600'
  return <span className={`rounded px-2 py-0.5 text-[10px] font-semibold text-white ${colour}`}>{action}</span>
}

function ActiveSignals({ signals }: { signals: SignalProgressDTO[] }) {
  if (signals.length === 0) {
    return <p className="text-sm text-gray-400">No active signals for this symbol.</p>
  }
  return (
    <ul className="space-y-2">
      {signals.map((s) => {
        const lifecycle = s.lifecycleResolved ?? s.lifecycle ?? SignalLifecycle.Pending
        return (
          <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
            <div className="flex items-center gap-2">
              {actionBadge(s.action)}
              <span className="text-[10px] uppercase tracking-wide text-gray-400">
                {SignalLifecycle[lifecycle]?.toLowerCase() ?? 'pending'}
              </span>
            </div>
            <div className="flex items-center gap-3 font-mono text-xs text-gray-300">
              <span title="target weight">{(s.targetWeight * 100).toFixed(1)}%</span>
              {/* P&L is genuinely unknown until there's a current price — show "—", never 0. */}
              <span className={s.pnlPct === null ? 'text-gray-500' : s.pnlPct >= 0 ? 'text-green-400' : 'text-red-400'}>
                {s.pnlPct === null ? '—' : `${s.pnlPct >= 0 ? '+' : ''}${(s.pnlPct * 100).toFixed(2)}%`}
              </span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function StrategyExposure({ rows }: { rows: StrategyImpactRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-gray-400">No strategy has ranked or traded this symbol yet.</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-gray-500">
            <th className="pb-2 pr-4 font-medium">Strategy</th>
            <th className="pb-2 pr-4 font-medium">Rank</th>
            <th className="pb-2 pr-4 font-medium">Held %</th>
            <th className="pb-2 pr-4 font-medium">Avg hold</th>
            <th className="pb-2 pr-4 font-medium">Contribution</th>
            <th className="pb-2 font-medium">In book</th>
          </tr>
        </thead>
        <tbody className="font-mono text-xs text-gray-300">
          {rows.map((r) => (
            <tr key={r.strategyId} className="border-t border-gray-800">
              <td className="py-2 pr-4 font-sans text-gray-200">{r.strategyId}</td>
              {/* currentRank null ⇒ ranked-never; show "—", not a placeholder rank. */}
              <td className="py-2 pr-4">{r.currentRank === null ? '—' : r.currentRank}</td>
              <td className="py-2 pr-4">{(r.historicalInclusionPct * 100).toFixed(0)}%</td>
              <td className="py-2 pr-4">{r.avgHoldingDays > 0 ? `${r.avgHoldingDays.toFixed(0)}d` : '—'}</td>
              <td className={`py-2 pr-4 ${r.contributionPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {r.contributionPct >= 0 ? '+' : ''}
                {(r.contributionPct * 100).toFixed(2)}%
              </td>
              <td className="py-2">
                {r.selected ? (
                  <span className="text-emerald-400">held</span>
                ) : (
                  <span className="text-gray-500">no</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Sentiment chip — only when the tier returned a polarity (it's optional). polarity ∈ [-1,1].
function SentimentChip({ sentiment }: { sentiment?: NewsArticle['sentiment'] }) {
  if (!sentiment || typeof sentiment.polarity !== 'number') return null
  const p = sentiment.polarity
  const label = p > 0.05 ? 'positive' : p < -0.05 ? 'negative' : 'neutral'
  const colour = p > 0.05 ? 'text-green-400' : p < -0.05 ? 'text-red-400' : 'text-gray-400'
  return (
    <span className={`text-[10px] uppercase tracking-wide ${colour}`} title={`polarity ${p.toFixed(2)}`}>
      {label}
    </span>
  )
}

function RecentEvents({ articles }: { articles: NewsArticle[] }) {
  if (articles.length === 0) {
    return <p className="text-sm text-gray-400">No recent news for this symbol.</p>
  }
  return (
    <ul className="space-y-3">
      {articles.slice(0, MAX_EVENTS).map((a, i) => {
        const when = new Date(a.date)
        const dateLabel = Number.isNaN(when.getTime()) ? a.date : when.toISOString().slice(0, 10)
        return (
          <li key={`${a.link}-${i}`} className="border-l-2 border-gray-700 pl-3">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-gray-500">
              <span>{dateLabel}</span>
              <SentimentChip sentiment={a.sentiment} />
            </div>
            <a
              href={a.link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-sky-400 hover:text-sky-300 hover:underline"
            >
              {a.title}
            </a>
          </li>
        )
      })}
    </ul>
  )
}

export async function OverviewTab({ symbol }: { symbol: string }) {
  // Independent reads — fetch in parallel so a slow/absent source never blocks another panel.
  const [bars, scores, signals, exposure, news] = await Promise.all([
    fetchBars(symbol),
    fetchScores(symbol),
    fetchSymbolSignals(symbol),
    fetchExposure(symbol),
    fetchNews(symbol),
  ])
  const market = marketOf(symbol)

  return (
    <div className="space-y-5">
      {bars.length > 0 ? (
        <CandlestickChart bars={bars} />
      ) : (
        <div className="rounded-lg bg-gray-900 p-6 text-sm text-gray-400">
          No daily price history for <span className="font-mono text-gray-300">{symbol}</span> yet.
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <FactorBars ticker={symbol} initial={scores} />
        <Panel title="Active signals">
          <ActiveSignals signals={signals} />
        </Panel>
      </div>

      <Panel title="Strategy exposure">
        <StrategyExposure rows={exposure} />
      </Panel>

      <Panel title="Recent events">
        <div className="mb-1 flex items-center gap-2">
          <MarketBadge market={market} />
          <span className="text-[10px] uppercase tracking-wide text-gray-500">EODHD news</span>
        </div>
        <RecentEvents articles={news} />
      </Panel>
    </div>
  )
}
