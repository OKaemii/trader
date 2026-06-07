// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PortfolioOverviewHero,
  type EquityHeroPayload,
} from './PortfolioOverviewHero'

// Task 19 (epic-research-trading-os): the Workspace hero. These tests pin the safety-critical
// invariants — P&L renders for a demo/live account, paper mode degrades to a cash-only view (no
// fabricated curve), and the figures are present regardless of display mode (the hero is NEVER
// gated by <QuantOnly>; it takes no mode dependency at all, which these tests confirm by rendering
// it with no ModeProvider).

const fetchMock = vi.fn()

afterEach(() => {
  vi.restoreAllMocks()
  fetchMock.mockReset()
})

const gbp = (amount: number) => ({ amount, currency: 'GBP' as const })

const equity = (overrides: Partial<EquityHeroPayload['kpis']> = {}): EquityHeroPayload => ({
  days: 90,
  series: [
    { t: 1, nav: 10_000 },
    { t: 2, nav: 10_500 },
    { t: 3, nav: 11_000 },
  ],
  kpis: {
    current: 11_000,
    totalReturnPct: 0.1,
    currentDrawdownPct: -0.02,
    nSnapshots: 3,
    ...overrides,
  },
})

describe('PortfolioOverviewHero', () => {
  it('renders the equity curve and signed P&L / drawdown for a demo account', () => {
    render(
      <PortfolioOverviewHero
        cash={{ mode: 'Demo', total: gbp(11_000), free: gbp(3_000) }}
        equity={equity()}
      />,
    )

    // The focus: an accessible equity curve.
    expect(screen.getByRole('img', { name: /equity curve/i })).toBeInTheDocument()
    // P&L is signed and visible (the safety-relevant number).
    expect(screen.getByText('+10.00%')).toBeInTheDocument()
    // Current drawdown is signed negative.
    expect(screen.getByText('-2.00%')).toBeInTheDocument()
    // Exposure labels render (invested/available rail).
    expect(screen.getByText('Invested')).toBeInTheDocument()
    expect(screen.getByText('Available cash')).toBeInTheDocument()
  })

  it('colours a negative period return red', () => {
    render(
      <PortfolioOverviewHero
        cash={{ mode: 'Live', total: gbp(9_000), free: gbp(1_000) }}
        equity={equity({ totalReturnPct: -0.05 })}
      />,
    )
    const pnl = screen.getByText('-5.00%')
    expect(pnl).toHaveClass('text-red-400')
  })

  it('degrades to a cash-only view in paper mode (no curve, no fabricated P&L)', () => {
    render(<PortfolioOverviewHero cash={{ mode: 'Paper' }} equity={null} />)

    expect(screen.queryByRole('img', { name: /equity curve/i })).not.toBeInTheDocument()
    expect(screen.getByText(/paper mode/i)).toBeInTheDocument()
    // The value reads "—" (no broker NAV in paper).
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('shows an empty-curve hint when there are too few snapshots but still renders P&L', () => {
    render(
      <PortfolioOverviewHero
        cash={{ mode: 'Demo', total: gbp(10_000), free: gbp(5_000) }}
        equity={{ days: 90, series: [{ t: 1, nav: 10_000 }], kpis: {
          current: 10_000, totalReturnPct: 0.03, currentDrawdownPct: -0.01, nSnapshots: 1,
        } }}
      />,
    )
    expect(screen.getByText(/not enough nav snapshots/i)).toBeInTheDocument()
    // Still shows the P&L tile rather than hiding the figure when the curve can't be drawn.
    expect(screen.getByText('+3.00%')).toBeInTheDocument()
  })

  it('does not fetch when both seeds are provided', () => {
    vi.stubGlobal('fetch', fetchMock)
    render(
      <PortfolioOverviewHero
        cash={{ mode: 'Demo', total: gbp(11_000), free: gbp(3_000) }}
        equity={equity()}
      />,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
