// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ModeProvider } from './ModeProvider'
import { StrategyExposureTable, type StrategyExposureRow } from './StrategyExposureTable'

// Shared per-symbol exposure table (research-trading-os Task 38 §C). Pins that the advanced
// attribution columns (Held %, Avg hold, Contribution) are <QuantOnly>-gated — the consolidation
// that fixed the Overview/drawer Beginner/Quant divergence — while the safe baseline (strategy ·
// rank · in-book) stays visible in both modes, plus the honesty rules (null rank → "—").
const row = (over: Partial<StrategyExposureRow> = {}): StrategyExposureRow => ({
  strategyId: 'factor_rank_v1',
  currentRank: 3,
  historicalInclusionPct: 0.42,
  avgHoldingDays: 12.5,
  contributionPct: 0.08,
  selected: true,
  ...over,
})

function renderInMode(rows: StrategyExposureRow[], mode: 'quant' | 'beginner', dense = false) {
  return render(
    <ModeProvider initial={mode}>
      <StrategyExposureTable rows={rows} dense={dense} />
    </ModeProvider>,
  )
}

const headerNames = () => screen.getAllByRole('columnheader').map((th) => th.textContent)

describe('StrategyExposureTable', () => {
  it('renders an honest empty state when no strategy has touched the ticker', () => {
    renderInMode([], 'quant')
    expect(screen.getByText(/No strategy has ranked or traded/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('renders a null currentRank as "—", never a fabricated rank 0', () => {
    renderInMode([row({ currentRank: null })], 'quant')
    const cells = screen.getAllByRole('cell').map((td) => td.textContent)
    expect(cells).toContain('—')
    expect(cells).not.toContain('0')
  })

  it('shows the advanced attribution columns in quant mode', () => {
    renderInMode([row()], 'quant')
    const headers = headerNames()
    expect(headers).toContain('Held %')
    expect(headers).toContain('Avg hold')
    expect(headers).toContain('Contribution')
    expect(headers).toContain('In book')
  })

  it('hides the advanced attribution columns in beginner mode, keeping the safe baseline', () => {
    renderInMode([row()], 'beginner')
    const headers = headerNames()
    expect(headers).not.toContain('Held %')
    expect(headers).not.toContain('Avg hold')
    expect(headers).not.toContain('Contribution')
    // Strategy / Rank / In book stay visible in both modes.
    expect(headers).toContain('Strategy')
    expect(headers).toContain('Rank')
    expect(headers).toContain('In book')
  })

  it('omits the Avg-hold column when no row carries avgHoldingDays (the drawer fetch)', () => {
    renderInMode([row({ avgHoldingDays: undefined })], 'quant')
    const headers = headerNames()
    expect(headers).not.toContain('Avg hold')
    // The other advanced columns still render.
    expect(headers).toContain('Held %')
    expect(headers).toContain('Contribution')
  })
})
