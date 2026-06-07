// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketNarrative, type NarrativePayload } from './MarketNarrative'

// Task 31 §F: the MarketNarrative panel renders the data-grounded market prose (T30 endpoint)
// through the shared <Markdown> renderer, subtly labels whether the prose is LLM-phrased or the
// deterministic template fallback, and is graceful pre-first-cycle (asOf null → still renders
// words). These tests pin the SSR-seeded render, both source labels, the null-asOf trading-day
// fallback, and the unseeded client-fetch path.

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

function payload(over: Partial<NarrativePayload> = {}): NarrativePayload {
  return {
    narrative: '## Market\n\nBreadth is **healthy** with 62% of names above their 200-DMA.',
    source: 'llm',
    asOf: Date.UTC(2026, 5, 6, 21, 0, 0),
    tradingDay: '2026-06-06',
    generatedAt: Date.UTC(2026, 5, 6, 22, 5, 0),
    cached: true,
    ...over,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('MarketNarrative (server-seeded)', () => {
  it('renders the narrative markdown and the as-of stamp', () => {
    const { container } = render(<MarketNarrative initial={payload()} />)
    // Markdown turned the GFM into a real tree (heading + bold + paragraph).
    expect(screen.getByText('Market').tagName).toBe('H2')
    expect(container.querySelector('strong')).not.toBeNull()
    expect(screen.getByText(/62% of names above their 200-DMA/)).toBeInTheDocument()
    // as-of stamp present (knowledge time formatted).
    expect(screen.getByText(/as of /)).toBeInTheDocument()
  })

  it('labels LLM-phrased prose with the LLM badge', () => {
    render(<MarketNarrative initial={payload({ source: 'llm' })} />)
    expect(screen.getByText('LLM')).toBeInTheDocument()
    expect(screen.queryByText('Template')).not.toBeInTheDocument()
  })

  it('labels the deterministic fallback with the Template badge', () => {
    render(<MarketNarrative initial={payload({ source: 'template' })} />)
    expect(screen.getByText('Template')).toBeInTheDocument()
    expect(screen.queryByText('LLM')).not.toBeInTheDocument()
  })

  it('is graceful pre-first-cycle: null asOf falls back to the trading day, prose still renders', () => {
    render(
      <MarketNarrative
        initial={payload({
          asOf: null,
          source: 'template',
          narrative: 'Factor leadership not yet computed; breadth not yet available.',
        })}
      />,
    )
    expect(screen.getByText(/Factor leadership not yet computed/)).toBeInTheDocument()
    // No knowledge-time stamp; the trading-day fallback is shown instead.
    expect(screen.queryByText(/as of /)).not.toBeInTheDocument()
    expect(screen.getByText(/for 2026-06-06/)).toBeInTheDocument()
  })
})

describe('MarketNarrative (client fetch)', () => {
  it('fetches the narrative through the portal proxy when not SSR-seeded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload({ source: 'template' })))
    vi.stubGlobal('fetch', fetchMock)

    render(<MarketNarrative />)
    await waitFor(() =>
      expect(screen.getByText(/62% of names above their 200-DMA/)).toBeInTheDocument(),
    )
    expect(fetchMock).toHaveBeenCalledWith('/portal-api/admin/market/narrative', { cache: 'no-store' })
    // The fetched source label rendered too.
    expect(screen.getByText('Template')).toBeInTheDocument()
  })

  it('does NOT self-fetch when SSR-seeded (avoids the on-mount round trip)', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<MarketNarrative initial={payload()} />)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows an unavailable message (no fabricated prose) when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    render(<MarketNarrative />)
    await waitFor(() => expect(screen.getByText(/Market narrative unavailable/)).toBeInTheDocument())
  })
})
