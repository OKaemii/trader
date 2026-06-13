// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FundamentalsIngestPanel } from './FundamentalsIngestPanel'
import type { FreshnessAudit, FundamentalsSource } from '@/app/lib/fundamentals-merge'

// The Operations PIT-fundamentals panel, repointed at the fundamentals-HARVESTER surface (epic
// pit-fundamentals-lake-rearchitecture, Task 21): lake status (covered CIKs / bootstrap / last sweep /
// lake size), read-only config, the bare-symbol summary + per-name table, force-SWEEP, and the run
// history. There is NO quarantine panel and NO UA editor (decision D + the harvester has no config-PUT).

const NOW = 1_780_000_000_000

const status = {
  service: 'fundamentals-harvester',
  now_ms: NOW,
  bootstrap_complete: true,
  bootstrap: { completed_at: '2026-06-13T00:02:00Z', entities: 17_350, mode: 'full' },
  covered_ciks: 17_312,
  last_sweep_date: '2026-06-13',
  last_sweep_ciks: 42,
  lake_size_bytes: 3_221_225_472, // 3 GB
  lake_dir: '/data',
  has_ticker_history: true,
  has_entities: false,
}

const config = {
  lake_dir: '/data',
  sweep_minutes: 30,
  watchlist: [],
  watchlist_mode: false,
  edgar_reqs_per_sec: '10',
  edgar_user_agent_set: true,
}

const runs = {
  runs: [
    { date: '2026-06-13', ciks: 42 },
    { date: '2026-06-12', ciks: 38 },
  ],
  count: 2,
}

const freshness: FreshnessAudit = {
  universe: 3,
  covered: 2,
  missing: 1,
  stale: 1,
  coverage_pct: 66.67,
  retirable: false,
  no_edgar_count: 1,
  no_edgar: [
    { symbol: 'TCEHY', reason: 'unsponsored ADR — Tencent (HKEX 0700) files nothing with the SEC' },
  ],
  names: [
    {
      symbol: 'AAPL',
      cik: 320193,
      covered: true,
      newest_period_end: Date.parse('2025-03-31T00:00:00Z'),
      newest_knowledge_ts: Date.parse('2025-05-02T13:30:00Z'),
      last_filed: NOW - 3_600_000, // ~1h ago
      filing_cadence: 'quarterly',
      staleness_days: 53,
      stale: false,
    },
    {
      symbol: 'MSFT',
      cik: 789019,
      covered: false,
      newest_period_end: null,
      newest_knowledge_ts: null,
      last_filed: null,
      filing_cadence: 'quarterly',
      staleness_days: null,
      stale: true,
    },
  ],
}

const source: FundamentalsSource = {
  provider: 'pit',
  // 2 pit-edgar names (AAPL, GOOG) + 1 null (a non-US fail-closed name) — the live PIT-only vocabulary.
  sources: { 'pit-edgar': 2, null: 1 },
  by_ticker: {
    AAPL_US_EQ: { source: 'pit-edgar', built_at: NOW - 7_200_000 }, // ~2h ago — distinct from last_filed
    GOOG_US_EQ: { source: 'pit-edgar', built_at: NOW - 1_800_000 },
  },
  pit_served: 2,
  last_cycle_ts: NOW - 1_800_000,
}

function renderPanel(overrides: Partial<Parameters<typeof FundamentalsIngestPanel>[0]> = {}) {
  return render(
    <FundamentalsIngestPanel
      initialStatus={status}
      initialConfig={config}
      initialFreshness={freshness}
      initialSource={source}
      initialRuns={runs}
      universeSymbols={['AAPL', 'MSFT']}
      {...overrides}
    />,
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

describe('FundamentalsIngestPanel — harvester status surface (Task 21)', () => {
  it('renders the lake status: covered CIKs, bootstrap, last sweep, lake size', () => {
    renderPanel()
    expect(screen.getByText('17,312')).toBeInTheDocument() // covered CIKs
    expect(screen.getByText('complete')).toBeInTheDocument() // bootstrap_complete
    // the last-sweep date also appears in the runs list, so assert it shows at least once
    expect(screen.getAllByText('2026-06-13').length).toBeGreaterThan(0)
    expect(screen.getByText('3.0GB')).toBeInTheDocument() // lake size (3 GB → 1 dp under 10)
  })

  it('renders the read-only harvester config (sweep cadence, EDGAR UA set, watchlist mode)', () => {
    renderPanel()
    expect(screen.getByText('every 30m')).toBeInTheDocument()
    expect(screen.getByText('set (contact present)')).toBeInTheDocument()
    expect(screen.getByText('full universe')).toBeInTheDocument()
  })

  it('has NO quarantine panel and NO EDGAR User-Agent editor (decision D + no config-PUT)', () => {
    renderPanel()
    expect(screen.queryByTestId('quarantine-lookup')).not.toBeInTheDocument()
    expect(screen.queryByText(/Quarantine/i)).not.toBeInTheDocument()
    // the old UA editor had a Save button bound to a config PUT — it must be gone
    expect(screen.queryByPlaceholderText(/you@example.com/)).not.toBeInTheDocument()
  })

  it('renders the recent-sweeps history from /runs', () => {
    renderPanel()
    const runsCard = screen.getByTestId('harvester-runs')
    expect(within(runsCard).getByText('2026-06-13')).toBeInTheDocument()
    expect(within(runsCard).getByText(/42 CIKs refreshed/)).toBeInTheDocument()
  })
})

describe('FundamentalsIngestPanel — summary + per-name table (bare symbols)', () => {
  it('renders the summary with the PIT-only live source line (no yahoo-snapshot)', () => {
    renderPanel()
    const summary = screen.getByTestId('fundamentals-summary')
    expect(within(summary).getByText(/Live strategy source:/)).toBeInTheDocument()
    expect(within(summary).getByText('PIT (SEC EDGAR)')).toBeInTheDocument()
    // "pit-edgar 2" is split across text nodes in the same span — assert on the span's textContent.
    expect(summary.textContent).toMatch(/pit-edgar\s*2/)
    // the retired yahoo-snapshot line is gone from the summary
    expect(summary.textContent).not.toMatch(/yahoo-snapshot/)
    // PIT coverage C/U
    expect(within(summary).getByText('2/3')).toBeInTheDocument()
    expect(within(summary).getByText(/retirable:/)).toBeInTheDocument()
  })

  it('surfaces the no-EDGAR fail-closed exception list', () => {
    renderPanel()
    const noEdgar = screen.getByTestId('fundamentals-no-edgar')
    expect(noEdgar).toHaveTextContent(/1 name fail-closed \(no SEC filings\):/)
    const sym = within(noEdgar).getByText('TCEHY')
    expect(sym).toHaveAttribute('title', expect.stringContaining('unsponsored ADR'))
  })

  it('renders the per-name table keyed by BARE symbol with the lake + consume clocks', () => {
    renderPanel()
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent)
    expect(headers.some((h) => h?.includes('Last filed (SEC)'))).toBe(true)
    expect(headers.some((h) => h?.includes('Last read+built (strat.)'))).toBe(true)
    expect(headers.some((h) => h?.includes('Symbol'))).toBe(true)
    expect(headers.some((h) => h?.includes('Fiscal period (obs)'))).toBe(true)
    // bare symbols, not T212 tickers
    const table = screen.getByTestId('fundamentals-state-table')
    expect(within(table).getByText('AAPL')).toBeInTheDocument()
    expect(within(table).queryByText('AAPL_US_EQ')).not.toBeInTheDocument()
  })

  it('joins a T212-keyed source row onto the bare-keyed freshness row (AAPL distinct clocks)', () => {
    renderPanel()
    const table = screen.getByTestId('fundamentals-state-table')
    const aaplRow = within(table).getByText('AAPL').closest('tr')!
    const cells = within(aaplRow).getAllByRole('cell').map((td) => td.textContent)
    // last filed (UTC date) + last read+built ~2h ago — the two clocks genuinely differ on the row.
    expect(cells).toContain('2h ago')
    expect(cells).toContain('2025-03-31') // fiscal period UTC date
    expect(within(aaplRow).getByText('PIT')).toBeInTheDocument()
  })

  it('shows a source-only name (GOOG, from GOOG_US_EQ) and a freshness-only name (MSFT)', () => {
    renderPanel()
    const table = screen.getByTestId('fundamentals-state-table')
    expect(within(table).getByText('GOOG')).toBeInTheDocument() // source-only, bare
    expect(within(table).getByText('MSFT')).toBeInTheDocument() // freshness-only
  })

  it('filters the table to stale rows', () => {
    renderPanel()
    const table = screen.getByTestId('fundamentals-state-table')
    fireEvent.click(within(table).getByRole('button', { name: 'Stale' }))
    expect(within(table).getByText('MSFT')).toBeInTheDocument()
    expect(within(table).queryByText('AAPL')).not.toBeInTheDocument()
  })
})

describe('FundamentalsIngestPanel — force sweep', () => {
  it('posts to the force-sweep proxy after confirm', async () => {
    vi.useRealTimers()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ service: 'fundamentals-harvester', started: true }),
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Run sweep now' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith(
      '/portal-api/admin/fundamentals-ingest/force-sweep',
      expect.objectContaining({ method: 'POST' }),
    )
    await waitFor(() =>
      expect(screen.getByText(/Sweep triggered/)).toBeInTheDocument(),
    )
  })

  it('does not post when the operator cancels the confirm', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Run sweep now' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
