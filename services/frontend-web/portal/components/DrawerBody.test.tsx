// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The body mounts <DrawerNotes> → <ResearchNotes>, which calls useRouter().refresh() after a save;
// the unit harness has no App Router mounted, so stub next/navigation (same pattern as the
// ResearchNotes test). The Markdown renderer is stubbed for the same reason that test stubs it.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('@/components/ui/Markdown', () => ({
  Markdown: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}))

import { DrawerBody } from './DrawerBody'
import { ModeProvider } from './ModeProvider'
import type { Mode } from '@/app/lib/mode-parse'

// The body now mounts <StrategyExposureTable>, which reads useMode() (advanced attribution columns
// are gated by <QuantOnly>, consistent with the full route + Strategy Impact tab). useMode() throws
// outside a provider, so every render goes through a <ModeProvider>. Default `quant` so the existing
// assertions (which check the advanced columns render) hold; a dedicated test pins the beginner gate.
function renderInMode(ui: React.ReactElement, mode: Mode = 'quant') {
  return render(<ModeProvider initial={mode}>{ui}</ModeProvider>)
}

// Task 35 §G/§A: the universal drawer body composes the SAME condensed symbol panels the full
// /research?symbol= route shows, client-fetched via /portal-api/* on open with a per-symbol in-memory
// cache. These tests pin: (1) every panel paints populated from its proxy; (2) the honesty empty
// states render (no signals/exposure/news → explicit copy, never fabricated values); (3) the active
// slice excludes terminal-lifecycle signals; (4) the per-symbol cache means a reopen doesn't re-hit
// the proxies. lightweight-charts is mocked (jsdom has no canvas) so the chart container is inert.

vi.mock('lightweight-charts', () => {
  const lineSeries = () => ({ setData: () => {}, createPriceLine: () => {} })
  const timeScale = () => ({
    fitContent: () => {},
    subscribeVisibleLogicalRangeChange: () => {},
    setVisibleLogicalRange: () => {},
  })
  return {
    createChart: () => ({
      addCandlestickSeries: () => ({ setData: () => {} }),
      addHistogramSeries: () => ({ setData: () => {}, priceScale: () => ({ applyOptions: () => {} }) }),
      addLineSeries: lineSeries,
      timeScale,
      applyOptions: () => {},
      remove: () => {},
    }),
  }
})

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

// Route a fetch to the right canned payload by URL substring. Anything unmatched (e.g. the
// FactorBars / WhyPanel / DrawerNotes self-fetches) returns an empty object so those children render
// their own honest empty states without the test having to model every child's contract.
function routedFetch(payloads: Record<string, unknown>) {
  return vi.fn((url: string) => {
    for (const [needle, body] of Object.entries(payloads)) {
      if (url.includes(needle)) return Promise.resolve(jsonResponse(body))
    }
    return Promise.resolve(jsonResponse({}))
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('DrawerBody (populated)', () => {
  beforeEach(() => {
    const fetchMock = routedFetch({
      'market-data/bars/AAPL_US_EQ': {
        bars: [
          { observation_ts: 1_700_000_000_000, open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
          { observation_ts: 1_700_086_400_000, open: 10.5, high: 12, low: 10, close: 11.0, volume: 120 },
        ],
      },
      'universe/overrides': {
        activeUniverseDetailed: [{ ticker: 'AAPL_US_EQ', name: 'Apple Inc.', sector: 'Technology' }],
      },
      'by-ticker/AAPL_US_EQ': {
        signals: [
          // Active (Queued=2) — should render with a Why? panel.
          { id: 's1', timestamp: 1_700_000_000_000, ticker: 'AAPL_US_EQ', strategy_id: 'factor_rank_v1', action: 'BUY', confidence: 0.8, targetWeight: 0.05, lifecycle: 2 },
          // Terminal (Closed=5) — should be excluded from the active slice.
          { id: 's2', timestamp: 1_699_000_000_000, ticker: 'AAPL_US_EQ', strategy_id: 'factor_rank_v1', action: 'SELL', confidence: 0.6, targetWeight: 0, lifecycle: 5 },
        ],
      },
      'strategy-impact?ticker=AAPL_US_EQ': {
        strategies: [
          { strategyId: 'factor_rank_v1', currentRank: 3, historicalInclusionPct: 0.42, contributionPct: 0.015, selected: true },
        ],
      },
      'market-data/news?ticker=AAPL_US_EQ': {
        articles: [{ date: '2026-06-01', title: 'Apple ships a thing', link: 'https://example.com/a' }],
      },
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  it('paints the identity strip, exposure, active signal, and news from the proxies', async () => {
    renderInMode(<DrawerBody symbol="AAPL_US_EQ" />)
    // Identity (name + sector + last close + 1-day change off the two bars).
    await waitFor(() => expect(screen.getByText('Apple Inc.')).toBeInTheDocument())
    expect(screen.getByText('Technology')).toBeInTheDocument()
    expect(screen.getByText('11.00')).toBeInTheDocument() // last close
    expect(screen.getByText(/\+4\.76%/)).toBeInTheDocument() // (11 - 10.5)/10.5

    // Strategy exposure row.
    expect(screen.getByText('Strategy exposure')).toBeInTheDocument()
    expect(screen.getByText('held')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()

    // Active signal s1 renders; terminal s2's SELL does not surface a signal card.
    expect(screen.getByText('BUY')).toBeInTheDocument()
    expect(screen.getByText('queued')).toBeInTheDocument()
    // The full-analysis deep link points at the signal detail page.
    const link = screen.getByText('full →').closest('a')
    expect(link).toHaveAttribute('href', '/signals/s1')

    // Recent events headline + outbound link.
    expect(screen.getByText('Apple ships a thing')).toBeInTheDocument()
  })

  it('excludes terminal-lifecycle signals from the active slice', async () => {
    renderInMode(<DrawerBody symbol="AAPL_US_EQ" />)
    await waitFor(() => expect(screen.getByText('BUY')).toBeInTheDocument())
    // The closed SELL must not appear as an active card.
    expect(screen.queryByText('SELL')).not.toBeInTheDocument()
  })

  it('gates the advanced exposure columns in beginner mode but keeps the safe baseline', async () => {
    renderInMode(<DrawerBody symbol="AAPL_US_EQ" />, 'beginner')
    // Safe baseline stays visible in beginner: the strategy ranked/held this name.
    await waitFor(() => expect(screen.getByText('held')).toBeInTheDocument())
    // Advanced attribution (Held %/inclusion + Contribution) is curated away in beginner mode.
    expect(screen.queryByText('Held %')).not.toBeInTheDocument()
    expect(screen.queryByText('42%')).not.toBeInTheDocument()
    expect(screen.queryByText('Contribution')).not.toBeInTheDocument()
  })
})

describe('DrawerBody (honest empty states)', () => {
  it('renders explicit empty copy when a symbol has no signals/exposure/news', async () => {
    vi.stubGlobal('fetch', routedFetch({})) // every source returns {}
    renderInMode(<DrawerBody symbol="EMPTY_US_EQ" />)
    await waitFor(() => expect(screen.getByText('No active signals for this symbol.')).toBeInTheDocument())
    expect(screen.getByText('No strategy has ranked or traded this symbol yet.')).toBeInTheDocument()
    expect(screen.getByText('No recent news for this symbol.')).toBeInTheDocument()
    // No daily bars → the no-history chart fallback, not a fabricated chart.
    expect(screen.getByText(/No daily price history/i)).toBeInTheDocument()
  })
})

describe('DrawerBody (per-symbol cache)', () => {
  it('serves a reopened symbol from cache without re-hitting the proxies', async () => {
    const fetchMock = routedFetch({
      'by-ticker/CACHE_US_EQ': {
        signals: [
          { id: 'c1', timestamp: 1_700_000_000_000, ticker: 'CACHE_US_EQ', strategy_id: 'factor_rank_v1', action: 'BUY', confidence: 0.7, targetWeight: 0.04, lifecycle: 2 },
        ],
      },
    })
    vi.stubGlobal('fetch', fetchMock)

    // First open: the body fetches its 5 direct panels (bars/universe/by-ticker/exposure/news).
    const first = renderInMode(<DrawerBody symbol="CACHE_US_EQ" />)
    await waitFor(() => expect(screen.getByText('BUY')).toBeInTheDocument())
    const directCalls = (url: string) =>
      url.includes('CACHE_US_EQ') &&
      (url.includes('/bars/') || url.includes('universe/overrides') || url.includes('by-ticker/') || url.includes('strategy-impact') || url.includes('market-data/news'))
    const callsAfterFirst = fetchMock.mock.calls.filter(([u]) => directCalls(u as string)).length
    expect(callsAfterFirst).toBeGreaterThan(0)
    first.unmount()

    // Reopen the SAME symbol — the cached promise resolves with no new direct proxy calls.
    renderInMode(<DrawerBody symbol="CACHE_US_EQ" />)
    await waitFor(() => expect(screen.getByText('BUY')).toBeInTheDocument())
    const callsAfterSecond = fetchMock.mock.calls.filter(([u]) => directCalls(u as string)).length
    expect(callsAfterSecond).toBe(callsAfterFirst)
  })
})
