// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModeProvider } from './ModeProvider'
import { FundamentalsIngestPanel } from './FundamentalsIngestPanel'
import type { FreshnessAudit, FundamentalsSource } from '@/app/lib/fundamentals-merge'

// card 149 — the Operations PIT-fundamentals panel's new surfaces: the always-visible summary, the
// full per-ticker state table with BOTH provenance clocks, and the <QuantOnly> per-name quarantine
// lookup. Rendered through the real <ModeProvider> so the quant-gated lookup mounts.

const NOW = 1_780_000_000_000

const freshness: FreshnessAudit = {
  universe: 3,
  covered: 2,
  missing: 1,
  stale: 1,
  coverage_pct: 66.67,
  retirable: false,
  // The EDGAR-eligible denominator excludes a no-EDGAR name (epic Task A4): TCEHY files nothing with the
  // SEC, so it degrades to Yahoo and is surfaced as an exception, not counted missing.
  no_edgar_count: 1,
  no_edgar: [
    { symbol: 'TCEHY', reason: 'unsponsored ADR — Tencent (HKEX 0700) files nothing with the SEC' },
  ],
  last_ingest_run: { state: 'done', finished_at_ms: NOW - 60_000 },
  names: [
    {
      symbol: 'AAPL',
      ticker: 'AAPL_US_EQ',
      instrument_id: 1,
      covered: true,
      newest_period_end: Date.parse('2025-03-31T00:00:00Z'),
      newest_knowledge_ts: Date.parse('2025-05-02T13:30:00Z'),
      last_stored_at: NOW - 3_600_000, // ~1h ago
      staleness_days: 53,
      stale: false,
    },
    {
      symbol: 'MSFT',
      ticker: 'MSFT_US_EQ',
      instrument_id: 2,
      covered: false,
      newest_period_end: null,
      newest_knowledge_ts: null,
      last_stored_at: null,
      staleness_days: null,
      stale: true,
    },
  ],
}

const source: FundamentalsSource = {
  provider: 'pit',
  sources: { 'pit-edgar': 1, 'yahoo-snapshot': 1, null: 1 },
  by_ticker: {
    AAPL_US_EQ: { source: 'pit-edgar', built_at: NOW - 7_200_000 }, // ~2h ago — distinct from last_stored
    GOOG_US_EQ: { source: 'yahoo-snapshot', built_at: NOW - 1_800_000 },
  },
  pit_served: 1,
  last_cycle_ts: NOW - 1_800_000,
}

function renderPanel() {
  return render(
    <ModeProvider initial="quant">
      <FundamentalsIngestPanel
        initialStatus={null}
        initialConfig={null}
        initialFreshness={freshness}
        initialSource={source}
      />
    </ModeProvider>,
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('FundamentalsIngestPanel — summary + per-ticker table (card 149)', () => {
  it('renders the always-visible summary with live source, coverage, stale, retirable', () => {
    renderPanel()
    const summary = screen.getByTestId('fundamentals-summary')
    expect(within(summary).getByText(/Live strategy source:/)).toBeInTheDocument()
    expect(within(summary).getByText('PIT (SEC EDGAR)')).toBeInTheDocument()
    expect(within(summary).getByText(/pit-edgar 1/)).toBeInTheDocument()
    expect(within(summary).getByText(/yahoo-snapshot 1/)).toBeInTheDocument()
    // PIT coverage C/U
    expect(within(summary).getByText('2/3')).toBeInTheDocument()
    // retirable: no (missing=1)
    expect(within(summary).getByText(/retirable:/)).toBeInTheDocument()
    expect(within(summary).getByText('no')).toBeInTheDocument()
  })

  it('surfaces the no-EDGAR exception list beside the audit (epic Task A4)', () => {
    renderPanel()
    const noEdgar = screen.getByTestId('fundamentals-no-edgar')
    // "N names degrade to Yahoo (no SEC filings): …" — the documented degrade-to-Yahoo exception.
    expect(noEdgar).toHaveTextContent(/1 name degrade to Yahoo \(no SEC filings\):/)
    const sym = within(noEdgar).getByText('TCEHY')
    expect(sym).toBeInTheDocument()
    // the curated reason is on the symbol's tooltip (title), not silently dropped
    expect(sym).toHaveAttribute('title', expect.stringContaining('unsponsored ADR'))
  })

  it('omits the no-EDGAR line when there are no exceptions', () => {
    render(
      <ModeProvider initial="quant">
        <FundamentalsIngestPanel
          initialStatus={null}
          initialConfig={null}
          initialFreshness={{ ...freshness, no_edgar_count: 0, no_edgar: [] }}
          initialSource={source}
        />
      </ModeProvider>,
    )
    expect(screen.queryByTestId('fundamentals-no-edgar')).not.toBeInTheDocument()
  })

  it('renders the per-ticker table with BOTH clock columns', () => {
    renderPanel()
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent)
    // The two clocks are the load-bearing columns — both must be present (and distinct from each other).
    expect(headers.some((h) => h?.includes('Last stored (ingest)'))).toBe(true)
    expect(headers.some((h) => h?.includes('Last read+built (strat.)'))).toBe(true)
    // plus the rest of the documented row shape
    expect(headers.some((h) => h?.includes('Ticker'))).toBe(true)
    expect(headers.some((h) => h?.includes('Source'))).toBe(true)
    expect(headers.some((h) => h?.includes('Covered'))).toBe(true)
    expect(headers.some((h) => h?.includes('Fiscal period (obs)'))).toBe(true)
    expect(headers.some((h) => h?.includes('Availability'))).toBe(true)
    expect(headers.some((h) => h?.includes('Stale?'))).toBe(true)
  })

  it('renders a merged row with both clocks showing distinct values for AAPL', () => {
    renderPanel()
    const table = screen.getByTestId('fundamentals-state-table')
    const aaplRow = within(table).getByText('AAPL_US_EQ').closest('tr')!
    const cells = within(aaplRow).getAllByRole('cell').map((td) => td.textContent)
    // last stored ~1h ago, last read+built ~2h ago — the two clocks genuinely differ on the row.
    expect(cells).toContain('1h ago')
    expect(cells).toContain('2h ago')
    // fiscal period (UTC date) + the PIT source tag
    expect(cells).toContain('2025-03-31')
    expect(within(aaplRow).getByText('PIT')).toBeInTheDocument()
  })

  it('shows a source-only ticker (GOOG) and a freshness-only ticker (MSFT) — full outer join', () => {
    renderPanel()
    const table = screen.getByTestId('fundamentals-state-table')
    expect(within(table).getByText('GOOG_US_EQ')).toBeInTheDocument() // source-only
    expect(within(table).getByText('MSFT_US_EQ')).toBeInTheDocument() // freshness-only
  })

  it('filters the table to stale rows', () => {
    renderPanel()
    const table = screen.getByTestId('fundamentals-state-table')
    fireEvent.click(within(table).getByRole('button', { name: 'Stale' }))
    expect(within(table).getByText('MSFT_US_EQ')).toBeInTheDocument()
    expect(within(table).queryByText('AAPL_US_EQ')).not.toBeInTheDocument()
  })

  it('the quarantine lookup posts the ticker to the …/quarantine?symbol= proxy', async () => {
    // Real timers for this one: the async handler + waitFor poll on real timers; fake timers would
    // stall waitFor. This test asserts the fetch call + the rendered result, neither time-dependent.
    vi.useRealTimers()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        resolved: true,
        symbol: 'AAPL',
        instrument_id: 1,
        total: 3,
        by_reason: { value_disagreement: 3 },
        by_sector: {},
        recent: [],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    renderPanel()
    const lookup = screen.getByTestId('quarantine-lookup')
    fireEvent.change(within(lookup).getByPlaceholderText('e.g. AAPL'), { target: { value: 'aapl' } })
    fireEvent.click(within(lookup).getByRole('button', { name: 'Look up' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // proxy hit with the (upper-cased) symbol forwarded as ?symbol=
    expect(fetchMock).toHaveBeenCalledWith(
      '/portal-api/admin/fundamentals-ingest/quarantine?symbol=AAPL',
      expect.objectContaining({ cache: 'no-store' }),
    )
    // The scoped result renders the resolved symbol's quarantine count + the by-reason breakdown.
    await waitFor(() => expect(within(lookup).getByText(/quarantined event/)).toBeInTheDocument())
    expect(within(lookup).getByText(/value_disagreement:/)).toBeInTheDocument()
    // the count "3" surfaces in the result (both the total span + the by-reason span render it)
    expect(within(lookup).getAllByText('3').length).toBeGreaterThan(0)
  })

  it('the quarantine lookup is hidden in beginner mode (forensic, quant-only)', () => {
    render(
      <ModeProvider initial="beginner">
        <FundamentalsIngestPanel
          initialStatus={null}
          initialConfig={null}
          initialFreshness={freshness}
          initialSource={source}
        />
      </ModeProvider>,
    )
    expect(screen.queryByTestId('quarantine-lookup')).not.toBeInTheDocument()
    // but the summary + table stay visible (operational, never mode-gated)
    expect(screen.getByTestId('fundamentals-summary')).toBeInTheDocument()
    expect(screen.getByTestId('fundamentals-state-table')).toBeInTheDocument()
  })
})
