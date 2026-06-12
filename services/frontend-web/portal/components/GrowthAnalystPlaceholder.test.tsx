// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GrowthAnalystPlaceholder } from './GrowthAnalystPlaceholder'

// epic pit-fundamentals-lake-rearchitecture / decision I — the Yahoo analyst-estimates source was
// dropped, so the Research Fundamentals tab's forward-growth + analyst sections render a
// "PIT-sourced — coming soon" placeholder (no fetch, no stale data, no crash) until a point-in-time
// source is wired.

describe('GrowthAnalystPlaceholder', () => {
  it('renders both the growth and analyst-estimates section titles', () => {
    render(<GrowthAnalystPlaceholder />)
    expect(screen.getByText('Growth (forward estimates)')).toBeInTheDocument()
    expect(screen.getByText('Analyst estimates')).toBeInTheDocument()
  })

  it('tags each section as PIT-sourced coming soon', () => {
    render(<GrowthAnalystPlaceholder />)
    const tags = screen.getAllByText('PIT · coming soon')
    expect(tags).toHaveLength(2)
  })

  it('shows the "not yet available" copy and names no Yahoo data', () => {
    const { container } = render(<GrowthAnalystPlaceholder />)
    expect(screen.getAllByText(/not yet available/i)).toHaveLength(2)
    // No stale third-party (Yahoo) figures or a price target / recommendation leak through.
    expect(container.textContent).not.toMatch(/price target/i)
    expect(container.textContent).not.toMatch(/recommendation/i)
  })
})
