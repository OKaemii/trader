// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FundamentalsSourceTag } from './FundamentalsSourceTag'

// plan §J — the reusable per-ticker provenance badge. The honest contract: PIT (our SEC-EDGAR
// warehouse) vs Yahoo (third-party snapshot) vs none, bucketed off the RAW source string via the
// shared provenanceKind (no second bucketing). The raw source must stay visible on hover (title).

describe('FundamentalsSourceTag', () => {
  it('renders PIT for a pit-edgar source, with the raw source on hover', () => {
    render(<FundamentalsSourceTag source="pit-edgar" />)
    const tag = screen.getByText('PIT')
    expect(tag).toBeInTheDocument()
    // raw source surfaces on hover so the operator can see the exact upstream behind the bucket
    expect(tag).toHaveAttribute('title', 'pit-edgar')
  })

  it('renders Yahoo for a yahoo-snapshot source, with the raw source on hover', () => {
    render(<FundamentalsSourceTag source="yahoo-snapshot" />)
    const tag = screen.getByText('Yahoo')
    expect(tag).toBeInTheDocument()
    expect(tag).toHaveAttribute('title', 'yahoo-snapshot')
  })

  it('renders the scanner snapshot vocabulary (bare "yahoo") as Yahoo', () => {
    // the scanner (card 148) stamps rows with the bare provider name, not the *-snapshot form.
    render(<FundamentalsSourceTag source="yahoo" />)
    expect(screen.getByText('Yahoo')).toBeInTheDocument()
  })

  it('renders none (—) for a null source', () => {
    render(<FundamentalsSourceTag source={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    // no PIT / Yahoo label leaks for an absent source
    expect(screen.queryByText('PIT')).not.toBeInTheDocument()
    expect(screen.queryByText('Yahoo')).not.toBeInTheDocument()
  })

  it('renders none (—) for undefined and for an unknown source', () => {
    const { rerender } = render(<FundamentalsSourceTag source={undefined} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    // an unrecognised provider (e.g. the scanner's "eodhd") is not PIT and not Yahoo → none
    rerender(<FundamentalsSourceTag source="eodhd" />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('PIT')).not.toBeInTheDocument()
    expect(screen.queryByText('Yahoo')).not.toBeInTheDocument()
  })

  it('passes through an extra className alongside the badge styles', () => {
    render(<FundamentalsSourceTag source="pit-edgar" className="ml-2" />)
    expect(screen.getByText('PIT')).toHaveClass('ml-2')
  })
})
