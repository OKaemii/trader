'use client'
// The universal research drawer's BODY (research-trading-os Task 35 §G/§A). The drawer is a
// condensed, in-context overlay of the SAME symbol panels the full /research?symbol= route shows —
// header, chart, factor bars, active signals (each with a Why? gate checklist), strategy exposure,
// notes, and recent events. Deep links still navigate to the full route; this is the overlay.
//
// CLIENT-ONLY by construction. The drawer (ResearchDrawer.tsx) is a client component mounted once in
// (authed)/layout.tsx, so it CANNOT call the server-only authedFetch the OverviewTab/SignalsTab
// server components use to SSR-seed. Instead this body client-fetches each panel through the
// /portal-api/* proxies when a symbol opens, with a tiny per-symbol in-memory cache so reopening the
// same symbol is instant (the open overlay is short-lived; the cache survives close→reopen).
//
// The reused shared components — CandlestickChart, FactorBars, WhyPanel, DrawerNotes — are the very
// same ones the full route mounts (no fork). FactorBars + WhyPanel self-fetch their own scores on
// mount (their dual-mode contract: pass no `initial` and they fetch), so the cache here only covers
// what THIS body fetches directly (bars, identity, signals, exposure, news).
import { useEffect, useState } from 'react'
import { CandlestickChart, type ChartBar } from '@/components/CandlestickChart'
import { FactorBars } from '@/components/FactorBars'
import { WhyPanel } from '@/components/WhyPanel'
import { DrawerNotes } from '@/components/DrawerNotes'
import { MarketBadge } from '@/components/MarketBadge'
import { marketOf } from '@/components/market'
import { StrategyExposureTable } from '@/components/StrategyExposureTable'

// ── Wire shapes (minimal subsets of the proxied responses) ────────────────────────────────────────
interface RawBar {
  observation_ts?: number
  timestamp?: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface UniverseEntry {
  ticker?: string
  name?: string
  sector?: string
}

// Numeric lifecycle on the wire (mirror of @trader/shared-types SignalLifecycle — see SignalsTab).
// Terminal = Closed(5)/Failed(6)/Cancelled(7); the drawer's "active" slice excludes those.
const LIFECYCLE_LABEL = ['Pending', 'Approved', 'Queued', 'Executing', 'Executed', 'Closed', 'Failed', 'Cancelled']
const TERMINAL_LIFECYCLES = new Set([5, 6, 7])

/** Subset of the by-ticker signal shape the drawer renders. Same source the full Signals tab uses. */
interface SignalRow {
  id: string
  timestamp: number
  ticker: string
  strategy_id: string
  action: 'BUY' | 'SELL' | 'HOLD'
  confidence: number
  targetWeight: number
  lifecycle?: number
}

/** One per-strategy exposure row (from /admin/api/signals/strategy-impact?ticker=). */
interface StrategyImpactRow {
  strategyId: string
  currentRank: number | null
  historicalInclusionPct: number
  contributionPct: number
  selected: boolean
}

interface NewsArticle {
  date: string
  title: string
  link: string
  sentiment?: { polarity: number }
}

/** Everything the body fetches directly for one symbol (FactorBars/WhyPanel self-fetch separately). */
interface DrawerData {
  bars: ChartBar[]
  identity: { name?: string; sector?: string }
  signals: SignalRow[]
  exposure: StrategyImpactRow[]
  news: NewsArticle[]
}

const MAX_ACTIVE_SIGNALS = 5
const MAX_EVENTS = 6

// Per-symbol in-memory cache. Keyed by symbol, holding the in-flight (or resolved) fetch promise so
// a close→reopen of the same symbol resolves instantly without re-hitting the proxies. Module-level
// so it persists across drawer open/close (the provider unmounts the body on close). Bounded loosely
// — research sessions touch a handful of names; if it ever needs eviction, switch to an LRU.
const cache = new Map<string, Promise<DrawerData>>()

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(url)
    if (!r.ok) return fallback
    return ((await r.json().catch(() => fallback)) as T) ?? fallback
  } catch {
    return fallback
  }
}

/** Load every directly-fetched panel for a symbol in parallel; each source degrades independently so
 *  a slow/absent one (pre-backfill scores, no news) never blanks the whole drawer. */
async function loadDrawerData(symbol: string): Promise<DrawerData> {
  const enc = encodeURIComponent(symbol)
  const [barsRes, identityRes, signalsRes, exposureRes, newsRes] = await Promise.all([
    fetchJson<{ bars?: RawBar[] }>(`/portal-api/admin/market-data/bars/${enc}?interval=daily&range=1y`, {}),
    fetchJson<{ activeUniverseDetailed?: UniverseEntry[]; sectorMap?: Record<string, string> }>(
      '/portal-api/admin/universe/overrides',
      {},
    ),
    fetchJson<{ signals?: SignalRow[] }>(`/portal-api/admin/signals/by-ticker/${enc}?limit=50`, {}),
    fetchJson<{ strategies?: StrategyImpactRow[] }>(`/portal-api/admin/signals/strategy-impact?ticker=${enc}`, {}),
    fetchJson<{ articles?: NewsArticle[] }>(`/portal-api/admin/market-data/news?ticker=${enc}`, {}),
  ])

  const bars: ChartBar[] = (barsRes.bars ?? []).map((b) => ({
    time: Math.floor((b.observation_ts ?? b.timestamp ?? 0) / 1000),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }))

  const hit = identityRes.activeUniverseDetailed?.find((d) => d.ticker === symbol)
  const sector = hit?.sector ?? identityRes.sectorMap?.[symbol]
  const identity = {
    name: hit?.name && hit.name.length > 0 ? hit.name : undefined,
    sector: sector && sector.length > 0 ? sector : undefined,
  }

  return {
    bars,
    identity,
    signals: signalsRes.signals ?? [],
    exposure: exposureRes.strategies ?? [],
    news: newsRes.articles ?? [],
  }
}

/** Cached loader — one in-flight promise per symbol, reused on reopen. */
function getDrawerData(symbol: string): Promise<DrawerData> {
  let p = cache.get(symbol)
  if (!p) {
    p = loadDrawerData(symbol)
    // If the load rejects (it shouldn't — every source degrades), drop the cache entry so a reopen
    // retries rather than re-serving a rejected promise.
    p.catch(() => cache.delete(symbol))
    cache.set(symbol, p)
  }
  return p
}

// ── Presentational sub-panels (condensed vs the full route, but the same data + honesty rules) ─────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-sm font-semibold text-white">{children}</h3>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-gray-800 pt-4">
      <SectionTitle>{title}</SectionTitle>
      {children}
    </div>
  )
}

/** Condensed identity strip — the drawer's stand-in for the server-only SymbolHeader. Last close +
 *  1-day change derive from the same daily bars the chart uses; a value we can't resolve shows "—". */
function DrawerHeader({ symbol, identity, bars }: { symbol: string; identity: DrawerData['identity']; bars: ChartBar[] }) {
  const market = marketOf(symbol)
  const ccy = market === 'LSE' ? 'GBP' : market === 'US' ? 'USD' : ''
  const last = bars.length > 0 ? bars[bars.length - 1]!.close : null
  const prev = bars.length >= 2 ? bars[bars.length - 2]!.close : null
  const changePct =
    last !== null && prev !== null && Number.isFinite(prev) && prev !== 0 ? (last - prev) / prev : null

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      {identity.name && <span className="text-sm text-gray-400">{identity.name}</span>}
      <MarketBadge market={market} />
      {identity.sector && (
        <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-400">
          {identity.sector}
        </span>
      )}
      {last !== null && Number.isFinite(last) && (
        <span className="ml-auto flex items-baseline gap-2">
          <span className="font-mono text-base text-white">
            {last.toFixed(2)}
            {ccy && <span className="ml-1 text-xs text-gray-500">{ccy}</span>}
          </span>
          {changePct !== null ? (
            <span
              className={`font-mono text-sm ${changePct >= 0 ? 'text-green-400' : 'text-red-400'}`}
              title="1-day change (last two daily closes)"
            >
              {changePct >= 0 ? '+' : ''}
              {(changePct * 100).toFixed(2)}%
            </span>
          ) : (
            <span className="text-sm text-gray-500" title="prior close unavailable">
              —
            </span>
          )}
        </span>
      )}
    </div>
  )
}

function actionTone(action: SignalRow['action']): string {
  return action === 'BUY' ? 'text-emerald-400' : action === 'SELL' ? 'text-red-400' : 'text-gray-300'
}

/** Active per-symbol signals (non-terminal lifecycle), newest-first, each with its as-of Why? panel.
 *  The by-ticker feed is the full audit trail; the drawer's "active" framing trims it to the live
 *  pipeline. WhyPanel mounts with NO seed (initial omitted) → it self-fetches its as-of scores. */
function ActiveSignals({ signals }: { signals: SignalRow[] }) {
  const active = signals.filter((s) => !TERMINAL_LIFECYCLES.has(s.lifecycle ?? 0)).slice(0, MAX_ACTIVE_SIGNALS)
  if (active.length === 0) {
    return <p className="text-sm text-gray-400">No active signals for this symbol.</p>
  }
  return (
    <div className="space-y-3">
      {active.map((s) => (
        <div key={s.id} className="space-y-2 rounded-lg border border-gray-800 bg-gray-950 p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`text-sm font-semibold ${actionTone(s.action)}`}>{s.action}</span>
            <span className="text-[10px] uppercase tracking-wide text-gray-400">
              {s.lifecycle !== undefined ? (LIFECYCLE_LABEL[s.lifecycle]?.toLowerCase() ?? 'unknown') : 'unknown'}
            </span>
            <span className="font-mono text-gray-500">{s.strategy_id}</span>
            <span className="ml-auto font-mono text-gray-400" title="target weight">
              {(s.targetWeight * 100).toFixed(1)}%
            </span>
            <a href={`/signals/${encodeURIComponent(s.id)}`} className="text-sky-400 hover:underline">
              full →
            </a>
          </div>
          {/* No `initial` → WhyPanel self-fetches scores as-of THIS signal's own timestamp. */}
          <WhyPanel symbol={s.ticker} asOf={s.timestamp} action={s.action} confidence={s.confidence} />
        </div>
      ))}
    </div>
  )
}

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

/**
 * The composed drawer body for one symbol. Mounted with key={symbol} by ResearchDrawer so a symbol
 * switch remounts it (fresh load + the keyed FactorBars/DrawerNotes re-fetch their own symbol data).
 */
export function DrawerBody({ symbol }: { symbol: string }) {
  const [data, setData] = useState<DrawerData | null>(null)

  useEffect(() => {
    let cancelled = false
    getDrawerData(symbol).then((d) => {
      if (!cancelled) setData(d)
    })
    return () => {
      cancelled = true
    }
  }, [symbol])

  return (
    <div className="mt-4 space-y-5">
      {/* Identity strip first (the server route renders SymbolHeader above the body; here it's inline). */}
      {data === null ? (
        <div className="h-6 animate-pulse rounded bg-gray-800" />
      ) : (
        <DrawerHeader symbol={symbol} identity={data.identity} bars={data.bars} />
      )}

      {/* Chart */}
      {data === null ? (
        <div className="h-48 animate-pulse rounded-lg bg-gray-800" />
      ) : data.bars.length > 0 ? (
        <CandlestickChart bars={data.bars} />
      ) : (
        <div className="rounded-lg bg-gray-900 p-4 text-sm text-gray-400">
          No daily price history for <span className="font-mono text-gray-300">{symbol}</span> yet.
        </div>
      )}

      {/* Factor percentiles — reused FactorBars, no seed so it self-fetches; key={symbol} remounts it. */}
      <FactorBars key={symbol} ticker={symbol} initial={null} />

      {/* Active signals + per-signal Why? gate checklists. */}
      <Section title="Active signals">
        {data === null ? (
          <div className="h-20 animate-pulse rounded-lg bg-gray-800" />
        ) : (
          <ActiveSignals signals={data.signals} />
        )}
      </Section>

      {/* Strategy exposure — shared table (advanced attribution columns gated by <QuantOnly>, same
          as the full route + Strategy Impact tab). `dense` for the drawer's tighter type/padding. */}
      <Section title="Strategy exposure">
        {data === null ? (
          <div className="h-16 animate-pulse rounded-lg bg-gray-800" />
        ) : (
          <StrategyExposureTable rows={data.exposure} dense />
        )}
      </Section>

      {/* Research notes (Task 34's self-contained slot, relocated into the composed body). DrawerNotes
          client-fetches + renders the symbol's note; key={symbol} remounts it on symbol change. */}
      <Section title="Research notes">
        <DrawerNotes key={symbol} ticker={symbol} />
      </Section>

      {/* Recent events (news) */}
      <Section title="Recent events">
        {data === null ? (
          <div className="h-16 animate-pulse rounded-lg bg-gray-800" />
        ) : (
          <RecentEvents articles={data.news} />
        )}
      </Section>
    </div>
  )
}

export default DrawerBody
