import { redirect } from 'next/navigation'
import { WorkspaceShell } from '@/components/WorkspaceShell'
import { SymbolHeader } from '@/components/SymbolHeader'
import { ResearchLanding, type PopularSymbol } from '@/components/ResearchLanding'
import { resolveTab } from '@/app/lib/tabs'
import { authedFetch } from '@/app/lib/auth-fetch'
import { OverviewTab } from './OverviewTab'
import { SignalsTab } from './SignalsTab'
import { StrategyImpactTab } from './StrategyImpactTab'
import { FundamentalsTab } from './FundamentalsTab'
import { HistoryTab } from './HistoryTab'
import { MarketSignalsTab } from './MarketSignalsTab'

// Research workspace — the symbol-centric research surface (research-trading-os Task 23 §E).
// Driven by BOTH `?symbol=` and `?tab=` (Next 16: searchParams is a Promise, MUST await):
//
//   • No `?symbol=`  → a LANDING (a prominent SymbolPicker + Recent/Popular rails). Two old
//     redirect-stub deep links land here with a `?tab=` but no symbol and keep working: the
//     `/signals` stub (`?tab=signals`) renders the whole-market MarketSignalsTab feed, and the
//     `/charts` stub (`?tab=history`) renders the price chart for a default ticker. Any other
//     no-symbol visit shows the picker-led landing.
//   • With `?symbol=` → the SymbolHeader + the active question-tab. Five question-tabs, each an
//     async server component taking `{ symbol }`; only the active one is rendered/awaited.
//
// The five tab files are scaffolded by THIS card so downstream cards (T24–T28) fill one tab's
// body each without touching this page (the tab switch + prop contract stay fixed here).
const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'signals', label: 'Signals' },
  { key: 'strategy-impact', label: 'Strategy Impact' },
  { key: 'fundamentals', label: 'Fundamentals' },
  { key: 'history', label: 'History' },
] as const

// Old deep-links to the relocated tabs (bookmarks / saved URLs) get a server-side redirect to
// their new home (Task 22) so `/research?tab=backtests` and `/research?tab=market-data` never
// silently resolve to the first Research tab. Keyed off the raw `?tab=` value (these keys are
// not in TABS, so they'd otherwise fall through to `overview`).
const RELOCATED_TABS: Record<string, string> = {
  backtests: '/build?tab=backtests',
  'market-data': '/operations?tab=market-data',
}

// Default symbol for the `/charts` → `?tab=history` stub when no `?symbol=` is supplied — the
// price chart still renders (the relocation contract: `/charts` keeps showing a chart). Matches
// the pre-Task-23 ChartsTab default.
const DEFAULT_HISTORY_TICKER = 'AAPL_US_EQ'
// How many universe names to seed the landing's "Popular" rail with.
const POPULAR_LIMIT = 12

/** Top-of-universe names for the landing's Popular rail. Server-seeded (it owns the
 *  authedFetch); a failed/absent upstream degrades to [] (the rail just hides). Mirrors the
 *  /portal-api/search universe body shape (app/lib/search-merge.ts UniverseBody). */
async function fetchPopular(): Promise<PopularSymbol[]> {
  try {
    const r = await authedFetch('/admin/api/market-data/universe/overrides')
    if (!r.ok) return []
    const body = (await r.json().catch(() => null)) as {
      activeUniverseDetailed?: Array<{ ticker?: string; name?: string; sector?: string }>
      activeUniverse?: string[]
      sectorMap?: Record<string, string>
    } | null
    if (!body) return []
    const detailed = body.activeUniverseDetailed
    if (detailed && detailed.length > 0) {
      return detailed
        .filter((d): d is { ticker: string } & typeof d => typeof d.ticker === 'string' && d.ticker.length > 0)
        .slice(0, POPULAR_LIMIT)
        .map((d) => ({ symbol: d.ticker, name: d.name ?? '', sector: d.sector ?? '' }))
    }
    const sectorMap = body.sectorMap ?? {}
    return (body.activeUniverse ?? [])
      .filter((t) => typeof t === 'string' && t.length > 0)
      .slice(0, POPULAR_LIMIT)
      .map((t) => ({ symbol: t, name: '', sector: sectorMap[t] ?? '' }))
  } catch {
    return []
  }
}

export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<{ symbol?: string; tab?: string }>
}) {
  const { symbol, tab } = await searchParams // searchParams is a Promise in Next 16 — MUST await
  if (tab && RELOCATED_TABS[tab]) redirect(RELOCATED_TABS[tab])

  // ── No symbol → landing (with the two stub-target special cases) ──────────────────────
  if (!symbol) {
    if (tab === 'signals') {
      // /signals stub: keep the whole-market signal feed under /research?tab=signals.
      return (
        <div className="space-y-6 p-6">
          <h1 className="text-2xl font-bold text-white">Research</h1>
          <MarketSignalsTab />
        </div>
      )
    }
    if (tab === 'history') {
      // /charts stub: keep a price chart under /research?tab=history.
      return (
        <div className="space-y-6 p-6">
          <h1 className="text-2xl font-bold text-white">Research</h1>
          <HistoryTab symbol={DEFAULT_HISTORY_TICKER} />
        </div>
      )
    }
    const popular = await fetchPopular()
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-bold text-white">Research</h1>
        <ResearchLanding popular={popular} />
      </div>
    )
  }

  // ── With a symbol → header + the active question-tab ──────────────────────────────────
  const active = resolveTab(TABS, tab) // unknown/absent -> first tab (overview)
  return (
    <WorkspaceShell title="Research" tabs={TABS} active={active}>
      <SymbolHeader symbol={symbol} />
      {active === 'overview' && <OverviewTab symbol={symbol} />}
      {active === 'signals' && <SignalsTab symbol={symbol} />}
      {active === 'strategy-impact' && <StrategyImpactTab symbol={symbol} />}
      {active === 'fundamentals' && <FundamentalsTab symbol={symbol} />}
      {active === 'history' && <HistoryTab symbol={symbol} />}
    </WorkspaceShell>
  )
}
