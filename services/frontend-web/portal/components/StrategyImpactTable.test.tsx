// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ModeProvider } from './ModeProvider'
import { StrategyImpactTable, type StrategyImpactRow } from './StrategyImpactTable'

// Strategy Impact table (Research Task 26 / plan §E). Proves the T12 contract gotchas render
// correctly and that the advanced attribution columns are <QuantOnly>-gated (no safety surface,
// so curating them away in beginner is purely density).
const row = (over: Partial<StrategyImpactRow>): StrategyImpactRow => ({
  strategyId: 'factor_rank_v1',
  currentRank: 3,
  historicalInclusionPct: 0.42,
  avgHoldingDays: 12.5,
  contributionPct: 0.08,
  selected: true,
  ...over,
})

function renderQuant(rows: StrategyImpactRow[]) {
  return render(
    <ModeProvider initial="quant">
      <StrategyImpactTable symbol="AAPL_US_EQ" rows={rows} />
    </ModeProvider>,
  )
}

describe('StrategyImpactTable', () => {
  it('renders an honest empty state when no strategy has touched the ticker', () => {
    renderQuant([])
    expect(screen.getByText(/No strategy has ranked or traded/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('renders currentRank === null as "not yet ranked", never as rank 0', () => {
    renderQuant([row({ currentRank: null })])
    expect(screen.getByText('not yet ranked')).toBeInTheDocument()
    expect(screen.queryByText('#0')).not.toBeInTheDocument()
  })

  it('renders a populated rank with a # prefix', () => {
    renderQuant([row({ currentRank: 3 })])
    expect(screen.getByText('#3')).toBeInTheDocument()
  })

  it('shows selected (latest) and inclusion (lifetime) independently so they can disagree', () => {
    // Recently-dropped name: not in the latest snapshot but with a non-zero lifetime inclusion.
    renderQuant([row({ selected: false, historicalInclusionPct: 0.6 })])
    expect(screen.getByText('No')).toBeInTheDocument()
    expect(screen.getByText('60.0%')).toBeInTheDocument()
  })

  it('shows a positive contribution signed and a negative one signed', () => {
    renderQuant([
      row({ strategyId: 'a', contributionPct: 0.08 }),
      row({ strategyId: 'b', contributionPct: -0.03 }),
    ])
    expect(screen.getByText('+8.0%')).toBeInTheDocument()
    expect(screen.getByText('-3.0%')).toBeInTheDocument()
  })

  // The word "Inclusion"/"Selected" also appears in the intro paragraph, so assert on the table
  // column headers specifically (role columnheader) to prove the <QuantOnly> gate, not the prose.
  const headerNames = () => screen.getAllByRole('columnheader').map((th) => th.textContent)

  it('shows the advanced attribution columns in quant mode', () => {
    renderQuant([row({})])
    const headers = headerNames()
    expect(headers).toContain('Inclusion')
    expect(headers).toContain('Avg hold')
    expect(headers).toContain('Contribution')
  })

  it('hides the advanced attribution columns in beginner mode, keeping rank + selected', () => {
    render(
      <ModeProvider initial="beginner">
        <StrategyImpactTable symbol="AAPL_US_EQ" rows={[row({})]} />
      </ModeProvider>,
    )
    const headers = headerNames()
    expect(headers).not.toContain('Inclusion')
    expect(headers).not.toContain('Avg hold')
    expect(headers).not.toContain('Contribution')
    // Strategy / Rank / Selected stay visible in both modes.
    expect(headers).toContain('Strategy')
    expect(headers).toContain('Rank')
    expect(headers).toContain('Selected')
  })
})
