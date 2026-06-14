// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DrawerProvider } from './ResearchDrawer'
import { ScannerPanel } from './ScannerPanel'

// plan §J (card 150) — the scanner per-name source tag + the honest screener-fundamentals relabel.
// The scanner snapshot carries a per-name `source` (card 148: 'pit-edgar' | 'yahoo' | 'eodhd' | null);
// each row tags it with the reusable <FundamentalsSourceTag>, and the feed-health line is relabelled
// to make clear it's the SCREENER's own QMJ source (PIT US / Yahoo other), not the live PIT strategy.
//
// Task 10 (RC5 + RC3): each row also carries the BARE `symbol` + an `unavailable` by-design flag. The
// panel displays the bare symbol (not the reconstructed T212 `ticker`) and renders "by design" for an
// unavailable (non-US fail-closed / no-EDGAR) name, distinct from a covered-but-pending dash.
//
// ScannerPanel renders <TickerChip>, which needs the <DrawerProvider> in scope.

const snapshot = {
  universeSize: 4,
  qualityKnown: 2,
  qualityPassCount: 1,
  rows: [
    {
      ticker: 'AAPL_US_EQ', symbol: 'AAPL', name: 'Apple Inc', market: 'US', sector: 'Technology',
      marketCapGbp: 2.4e12, ratios: { roe: 0.5, debtToEquity: 1.2, currentRatio: 1.1 },
      qualityPass: true, unavailable: false, source: 'pit-edgar',
    },
    {
      ticker: 'VOD_l_EQ', symbol: 'VOD', name: 'Vodafone Group', market: 'LSE', sector: 'Communication',
      marketCapGbp: 2.0e10, ratios: { roe: 0.05, debtToEquity: 0.9, currentRatio: 0.8 },
      qualityPass: false, unavailable: false, source: 'yahoo',
    },
    {
      ticker: 'NVDA_US_EQ', symbol: 'NVDA', name: 'Nvidia Corp', market: 'US', sector: 'Technology',
      marketCapGbp: 1.5e12, ratios: null, qualityPass: null, unavailable: null, source: null,
    },
    {
      // A by-design tombstone (non-US fail-closed) — the PIT source can never resolve it.
      ticker: 'STANl_EQ', symbol: 'STAN', name: 'Standard Chartered', market: 'LSE', sector: 'Financials',
      marketCapGbp: null, ratios: null, qualityPass: false, unavailable: true, source: null,
    },
  ],
}

const health = {
  eodhd: { callsUsedToday: 12, dailyCallLimit: 1000 },
  fundamentals: { count: 4, covered: 3, unavailable: 1, passing: 1, oldestAsOf: null },
  feed: { date: '2026-06-10', usPulledToday: true, lsePulledToday: false },
  config: { universeSource: 'eodhd_scan', dailyHistoryProvider: 'eodhd', fundamentalsProvider: 'yahoo', minMarketCapGbp: 5e9 },
}

// `covered`/`unavailable` are optional on the wire (a pre-Task-8 pod omits them), so the override
// health type makes the split fields optional — letting a legacy-shaped fixture be passed in.
type HealthOverride = Omit<typeof health, 'fundamentals'> & {
  fundamentals: { count: number; covered?: number; unavailable?: number; passing: number; oldestAsOf: number | null }
}
function renderPanel(over?: { snapshot?: typeof snapshot; health?: HealthOverride | null }) {
  return render(
    <DrawerProvider>
      <ScannerPanel
        initialSnapshot={over?.snapshot ?? snapshot}
        initialHealth={over?.health === undefined ? health : over.health}
        initialPie={null}
      />
    </DrawerProvider>,
  )
}

describe('ScannerPanel — per-name source tag + screener relabel (card 150)', () => {
  it('tags each row by its per-name source: PIT, Yahoo, and none', () => {
    renderPanel()
    const aapl = screen.getByText('Apple Inc').closest('tr')!
    expect(within(aapl).getByText('PIT')).toBeInTheDocument()
    expect(within(aapl).getByText('PIT')).toHaveAttribute('title', 'pit-edgar')

    const vod = screen.getByText('Vodafone Group').closest('tr')!
    expect(within(vod).getByText('Yahoo')).toBeInTheDocument()

    // null source → the badge renders the none marker, no PIT/Yahoo label on that row.
    const nvda = screen.getByText('Nvidia Corp').closest('tr')!
    expect(within(nvda).queryByText('PIT')).not.toBeInTheDocument()
    expect(within(nvda).queryByText('Yahoo')).not.toBeInTheDocument()
  })

  it('renders a Source column header', () => {
    renderPanel()
    expect(screen.getByRole('columnheader', { name: 'Source' })).toBeInTheDocument()
  })

  it('relabels the feed-health fundamentals line honestly (screener PIT/Yahoo, not bare provider)', () => {
    renderPanel()
    // the honest screener label distinguishing it from the live PIT strategy source
    expect(screen.getByText(/Screener fundamentals — PIT \(US\) \/ Yahoo \(other\)/)).toBeInTheDocument()
    // the old bare "Fundamentals src:" label is gone
    expect(screen.queryByText(/^Fundamentals src:/)).not.toBeInTheDocument()
  })

  it('still renders without health (the feed-health block is conditional)', () => {
    renderPanel({ health: null })
    // table + rows still render; no screener line without health
    expect(screen.getByText('Apple Inc')).toBeInTheDocument()
    expect(screen.queryByText(/Screener fundamentals/)).not.toBeInTheDocument()
  })
})

describe('ScannerPanel — bare-ticker display (RC5) + by-design fail-closed (RC3) (Task 10)', () => {
  it('renders the BARE symbol per row, never the reconstructed T212 ticker', () => {
    renderPanel()
    const aapl = screen.getByText('Apple Inc').closest('tr')!
    // The ticker cell shows 'AAPL', not 'AAPL_US_EQ'.
    expect(within(aapl).getByText('AAPL')).toBeInTheDocument()
    expect(within(aapl).queryByText('AAPL_US_EQ')).not.toBeInTheDocument()
    // The London name shows 'STAN', not 'STANl_EQ'.
    const stan = screen.getByText('Standard Chartered').closest('tr')!
    expect(within(stan).getByText('STAN')).toBeInTheDocument()
    expect(within(stan).queryByText('STANl_EQ')).not.toBeInTheDocument()
    // No reconstructed suffix form leaks anywhere in the table.
    expect(screen.queryByText(/_EQ/)).not.toBeInTheDocument()
  })

  it('keeps the canonical T212 id on the chip so the research drawer still resolves the instrument', () => {
    renderPanel()
    const aapl = screen.getByText('Apple Inc').closest('tr')!
    // The visible label is bare ('AAPL'); the chip's affordance carries the canonical id.
    expect(within(aapl).getByRole('button', { name: 'AAPL' })).toHaveAttribute('title', 'Open AAPL_US_EQ research')
  })

  it('shows a market badge beside the symbol', () => {
    renderPanel()
    const aapl = screen.getByText('Apple Inc').closest('tr')!
    expect(within(aapl).getByTitle('US listing')).toHaveTextContent('US')
    const stan = screen.getByText('Standard Chartered').closest('tr')!
    expect(within(stan).getByTitle('LSE listing')).toHaveTextContent('LSE')
  })

  it('renders "by design" for an unavailable name, distinct from a pending dash', () => {
    renderPanel()
    // The by-design tombstone row reads "by design" (honest fail-closed), with the explanatory title.
    const stan = screen.getByText('Standard Chartered').closest('tr')!
    const byDesign = within(stan).getByText('by design')
    expect(byDesign).toBeInTheDocument()
    expect(byDesign).toHaveAttribute('title', expect.stringContaining('by design'))
    // A covered-but-unfetched name (NVDA) shows a plain dash, NOT "by design".
    const nvda = screen.getByText('Nvidia Corp').closest('tr')!
    expect(within(nvda).queryByText('by design')).not.toBeInTheDocument()
  })

  it('shows the covered / by-design split in the feed-health line', () => {
    renderPanel()
    // Task 8 split surfaced: real covered rows + the by-design count, not a lumped "cached" total.
    expect(screen.getByText(/3 covered \/ 1 pass, 1 by design/)).toBeInTheDocument()
  })

  it('falls back to the cached/pass shape when the split fields are absent (pre-Task-8 pod)', () => {
    const legacyHealth = { ...health, fundamentals: { count: 2, passing: 1, oldestAsOf: null } }
    renderPanel({ health: legacyHealth })
    expect(screen.getByText(/2 cached \/ 1 pass/)).toBeInTheDocument()
  })
})
