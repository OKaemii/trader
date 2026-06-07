// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FactorBars, type FactorScores } from './FactorBars'

// Task 24 §E honesty rule: each of the four research factors renders its cross-sectional percentile
// as a bar, and a factor the strategy couldn't compute this cycle (pct: null) renders an explicit
// "—"/"unknown" — NEVER a fabricated 0. These tests pin both halves of that contract plus the two
// "no data" shapes (empty store → "not yet computed") and the client-fetch path the drawer relies on.

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('FactorBars (server-seeded)', () => {
  it('renders a percentile for each computed factor', () => {
    const initial: FactorScores = {
      ticker: 'AAPL_US_EQ',
      factors: {
        momentum: { raw: 1.83, pct: 92 },
        quality: { raw: 0.7, pct: 84 },
        value: { raw: -0.4, pct: 31 },
        volatility: { raw: -0.2, pct: 61 },
      },
    }
    render(<FactorBars ticker="AAPL_US_EQ" initial={initial} />)
    expect(screen.getByText('Momentum')).toBeInTheDocument()
    expect(screen.getByText('92')).toBeInTheDocument()
    expect(screen.getByText('84')).toBeInTheDocument()
    expect(screen.getByText('31')).toBeInTheDocument()
    expect(screen.getByText('61')).toBeInTheDocument()
  })

  it('renders "—"/"unknown" for a null-pct factor, never a 0', () => {
    const initial: FactorScores = {
      ticker: 'XYZ_US_EQ',
      factors: {
        momentum: { raw: 1.0, pct: 70 },
        quality: { raw: null, pct: null }, // not computable this cycle
        value: { raw: null, pct: null },
        volatility: { raw: 0.1, pct: 55 },
      },
    }
    render(<FactorBars ticker="XYZ_US_EQ" initial={initial} />)
    // Momentum/Volatility computed; Quality/Value unknown → two "unknown" markers, no "0".
    expect(screen.getByText('70')).toBeInTheDocument()
    expect(screen.getByText('55')).toBeInTheDocument()
    expect(screen.getAllByText('unknown')).toHaveLength(2)
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('shows a "not yet computed" empty state when the store has no factors', () => {
    render(<FactorBars ticker="NEW_US_EQ" initial={{}} />)
    expect(screen.getByText(/not yet computed/i)).toBeInTheDocument()
    // No factor rows rendered at all (the four labels are absent in the empty state).
    expect(screen.queryByText('Momentum')).not.toBeInTheDocument()
  })
})

describe('FactorBars (client fetch)', () => {
  it('fetches scores by ticker through the portal proxy on mount', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ticker: 'MSFT_US_EQ',
        factors: { momentum: { raw: 2.0, pct: 88 } },
      } satisfies FactorScores),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<FactorBars ticker="MSFT_US_EQ" />)
    await waitFor(() => expect(screen.getByText('88')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith('/portal-api/admin/strategy/scores?ticker=MSFT_US_EQ')
  })

  it('degrades to the empty state (not zeros) when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    render(<FactorBars ticker="ERR_US_EQ" />)
    await waitFor(() => expect(screen.getByText(/not yet computed/i)).toBeInTheDocument())
  })
})
