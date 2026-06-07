// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WhyPanel } from './WhyPanel'
import type { FactorScores } from './FactorBars'

// Task 25 §F: the "Why?" checklist turns the as-of factor percentiles into pass/fail gate rows.
// These tests pin (1) a cleared gate reads ✓, a missed gate ✗; (2) a null-pct factor renders an
// honest "no data", NEVER a fabricated pass/fail; (3) an empty store as-of the signal shows the
// "no gate snapshot" empty state; (4) the client path fetches scores AS-OF the signal's own
// timestamp (the point-in-time read, not now). Volatility uses the store's "higher pct = LOWER
// realised vol" convention, so a high vol-pct clears the "Low volatility" gate.

const ASOF = 1_700_000_000_000

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('WhyPanel (server-seeded)', () => {
  it('marks cleared gates ✓ and missed gates ✗ off the as-of percentiles', () => {
    const initial: FactorScores = {
      ticker: 'AAPL_US_EQ',
      observation_ts: ASOF,
      factors: {
        momentum: { raw: 1.83, pct: 95 }, // ≥90 → ✓
        quality: { raw: 0.7, pct: 50 }, // <70 → ✗
        value: { raw: -0.4, pct: 80 }, // ≥70 → ✓
        volatility: { raw: -0.2, pct: 65 }, // ≥60 → ✓ (low realised vol)
      },
    }
    render(<WhyPanel symbol="AAPL_US_EQ" asOf={ASOF} action="BUY" confidence={0.42} initial={initial} />)
    expect(screen.getByText(/Momentum > 90th pct \(95\)/)).toBeInTheDocument()
    expect(screen.getByText(/Cheap vs peers/)).toBeInTheDocument()
    expect(screen.getByText(/Low volatility/)).toBeInTheDocument()
    // 3 of 4 gates supported.
    expect(screen.getByText(/3 of 4 factor gates supported/)).toBeInTheDocument()
    // Signal context chips render.
    expect(screen.getByText('BUY')).toBeInTheDocument()
    expect(screen.getByText(/conf 42%/)).toBeInTheDocument()
  })

  it('renders an honest "no data" gate for a null-pct factor — never a pass/fail', () => {
    const initial: FactorScores = {
      ticker: 'XYZ_US_EQ',
      factors: {
        momentum: { raw: 2.0, pct: 92 }, // ✓
        quality: { raw: null, pct: null }, // no data
        value: { raw: null, pct: null }, // no data
        volatility: { raw: 0.1, pct: 70 }, // ✓
      },
    }
    render(<WhyPanel symbol="XYZ_US_EQ" asOf={ASOF} initial={initial} />)
    // Two factors couldn't be computed → two "no data as-of this signal" rows.
    expect(screen.getAllByText(/no data as-of this signal/)).toHaveLength(2)
    // Only the two computed, cleared gates count toward the supported tally.
    expect(screen.getByText(/2 of 4 factor gates supported/)).toBeInTheDocument()
  })

  it('shows the "no gate snapshot" empty state when the store is empty as-of the signal', () => {
    render(<WhyPanel symbol="NEW_US_EQ" asOf={ASOF} initial={{}} />)
    expect(screen.getByText(/No factor scores recorded/i)).toBeInTheDocument()
    // No gate rows at all in the empty state.
    expect(screen.queryByText(/Momentum > 90th pct/)).not.toBeInTheDocument()
  })
})

describe('WhyPanel (client fetch)', () => {
  it('fetches scores AS-OF the signal timestamp (point-in-time), not now', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ticker: 'MSFT_US_EQ',
        factors: { momentum: { raw: 2.0, pct: 91 } },
      } satisfies FactorScores),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<WhyPanel symbol="MSFT_US_EQ" asOf={ASOF} />)
    await waitFor(() => expect(screen.getByText(/Momentum > 90th pct \(91\)/)).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith(
      `/portal-api/admin/strategy/scores?ticker=MSFT_US_EQ&asOf=${ASOF}`,
    )
  })

  it('degrades to the empty state (not a fabricated verdict) when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    render(<WhyPanel symbol="ERR_US_EQ" asOf={ASOF} />)
    await waitFor(() => expect(screen.getByText(/No factor scores recorded/i)).toBeInTheDocument())
  })
})
