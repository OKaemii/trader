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
// ScannerPanel renders <TickerChip>, which needs the <DrawerProvider> in scope.

const snapshot = {
  universeSize: 3,
  qualityKnown: 2,
  qualityPassCount: 1,
  rows: [
    {
      ticker: 'AAPL_US_EQ', name: 'Apple Inc', market: 'US', sector: 'Technology',
      marketCapGbp: 2.4e12, ratios: { roe: 0.5, debtToEquity: 1.2, currentRatio: 1.1 },
      qualityPass: true, source: 'pit-edgar',
    },
    {
      ticker: 'VOD_l_EQ', name: 'Vodafone Group', market: 'LSE', sector: 'Communication',
      marketCapGbp: 2.0e10, ratios: { roe: 0.05, debtToEquity: 0.9, currentRatio: 0.8 },
      qualityPass: false, source: 'yahoo',
    },
    {
      ticker: 'NVDA_US_EQ', name: 'Nvidia Corp', market: 'US', sector: 'Technology',
      marketCapGbp: 1.5e12, ratios: null, qualityPass: null, source: null,
    },
  ],
}

const health = {
  eodhd: { callsUsedToday: 12, dailyCallLimit: 1000 },
  fundamentals: { count: 2, passing: 1, oldestAsOf: null },
  feed: { date: '2026-06-10', usPulledToday: true, lsePulledToday: false },
  config: { universeSource: 'eodhd_scan', dailyHistoryProvider: 'eodhd', fundamentalsProvider: 'yahoo', minMarketCapGbp: 5e9 },
}

function renderPanel(over?: { snapshot?: typeof snapshot; health?: typeof health | null }) {
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
