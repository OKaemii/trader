// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FreshnessTag } from './FreshnessTag'

// 2026-06-11 22:32 UTC
const TS = Date.UTC(2026, 5, 11, 22, 32, 0)

describe('FreshnessTag', () => {
  it('renders "Not live" + the UTC as-of time when stale', () => {
    render(<FreshnessTag asOf={TS} stale={true} />)
    expect(screen.getByText('Not live')).toBeInTheDocument()
    expect(screen.getByText(/as of 11 Jun 22:32 UTC/)).toBeInTheDocument()
  })

  it('renders "Live" when fresh', () => {
    render(<FreshnessTag asOf={TS} stale={false} />)
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(screen.getByText(/as of 11 Jun 22:32 UTC/)).toBeInTheDocument()
  })

  it('shows the as-of time but no Live/Not-live claim when undeterminable', () => {
    render(<FreshnessTag asOf={TS} stale={null} />)
    expect(screen.queryByText('Live')).not.toBeInTheDocument()
    expect(screen.queryByText('Not live')).not.toBeInTheDocument()
    expect(screen.getByText(/as of 11 Jun 22:32 UTC/)).toBeInTheDocument()
  })

  it('renders nothing when there is no as-of timestamp', () => {
    const { container } = render(<FreshnessTag asOf={null} stale={true} />)
    expect(container).toBeEmptyDOMElement()
  })
})
