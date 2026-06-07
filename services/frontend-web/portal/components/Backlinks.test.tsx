// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// research-trading-os Task 34 §G — "notes referencing this entity". Pins: the SSR seed renders
// immediately (no empty flash), the title/empty-state are entity-kind specific, a referrer deep-links
// to its subject symbol's Research overview, and the on-mount re-fetch queries the right kind+ref and
// replaces the seed (so a note saved elsewhere reflects after router.refresh()). fetch is mocked.

import { Backlinks, type BacklinkNote } from './Backlinks'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

const NOTE: BacklinkNote = {
  ticker: 'MSFT_US_EQ',
  body: '# Pairs idea\nLong MSFT vs @strategy:factor_rank_v1 short leg.',
  links: [{ kind: 'strategy', ref: 'factor_rank_v1' }],
  updatedBy: 'okaemii',
  updatedAt: Date.parse('2026-06-01T00:00:00Z'),
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('Backlinks', () => {
  beforeEach(() => {
    // Default: re-fetch returns the same seed so assertions on the seed hold.
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ kind: 'strategy', ref: 'factor_rank_v1', notes: [NOTE] }))
  })

  it('renders the SSR-seeded referrers with a deep-link to the subject symbol', async () => {
    render(<Backlinks kind="strategy" ref_="factor_rank_v1" initial={[NOTE]} />)
    expect(screen.getByText(/referencing this strategy/i)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'MSFT_US_EQ' })
    expect(link).toHaveAttribute('href', '/research?symbol=MSFT_US_EQ')
    // Summary = first non-blank line, heading marks stripped.
    expect(screen.getByText('Pairs idea')).toBeInTheDocument()
    // Let the on-mount re-fetch (returns the same seed) settle so its state update is flushed.
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
  })

  it('shows a kind-specific empty state with the @-mention hint when there are no referrers', async () => {
    // Re-fetch also returns empty so no post-mount state change races the assertion (no act warning).
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ kind: 'signal', ref: 'sig123', notes: [] }))
    render(<Backlinks kind="signal" ref_="sig123" initial={[]} />)
    expect(screen.getByText(/No research notes mention this signal yet/i)).toBeInTheDocument()
    expect(screen.getByText('@signal:sig123')).toBeInTheDocument()
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
  })

  it('re-fetches on mount with the right kind+ref and replaces the seed', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse({ kind: 'strategy', ref: 'factor_rank_v1', notes: [] }))
    render(<Backlinks kind="strategy" ref_="factor_rank_v1" initial={[NOTE]} />)
    // Seed visible first.
    expect(screen.getByRole('link', { name: 'MSFT_US_EQ' })).toBeInTheDocument()
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/portal-api/admin/research/notes/backlinks?kind=strategy&ref=factor_rank_v1',
      )
    })
    // Server now reports no referrers → the list updates to the empty state.
    await waitFor(() => expect(screen.getByText(/No research notes mention this strategy/i)).toBeInTheDocument())
  })

  it('keeps the seed on a failed re-fetch (never blanks an already-rendered list)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({}, false, 500))
    render(<Backlinks kind="strategy" ref_="factor_rank_v1" initial={[NOTE]} />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(screen.getByRole('link', { name: 'MSFT_US_EQ' })).toBeInTheDocument()
  })
})
