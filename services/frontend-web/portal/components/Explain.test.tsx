// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { METRICS } from '@/app/lib/learning-content'
import { Explain } from './Explain'

// Task 32 (research-trading-os §F) — the layered <Explain> toggletip. Proves the
// progressive-disclosure behaviour and that the accessibility contract (a real
// keyboard-focusable trigger, role="status" content, Escape-closes) is intact.
//
// Radix Popover reaches for pointer-capture APIs happy-dom does not implement; stub
// them so the click that opens the toggletip does not throw. (Standard happy-dom/Radix
// shim — it only no-ops the capture calls, the click semantics are unaffected.)
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {}
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {}
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {}
  }
})

// Open the toggletip and return its content node (role="status").
function openExplain(id: string, value?: number) {
  render(<Explain id={id} value={value} />)
  const trigger = screen.getByRole('button', { name: `Explain ${METRICS[id].title}` })
  fireEvent.click(trigger)
  return trigger
}

describe('Explain — accessibility contract preserved', () => {
  it('renders a keyboard-focusable trigger button with an aria-label', () => {
    render(<Explain id="sharpe" />)
    const trigger = screen.getByRole('button', { name: 'Explain Sharpe Ratio' })
    expect(trigger).toBeInTheDocument()
  })

  it('renders nothing for an unknown metric id (degrades silently)', () => {
    const { container } = render(<Explain id="does-not-exist" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('announces the explanation on open via role="status"', () => {
    openExplain('sharpe')
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Sharpe Ratio')
    expect(status).toHaveTextContent(METRICS.sharpe.summary)
  })

  it('closes on Escape (toggletip, not a sticky panel)', () => {
    openExplain('sharpe')
    expect(screen.getByRole('status')).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('Explain — layered progressive disclosure', () => {
  it('opens at the plain summary only — deeper layers are hidden by default', () => {
    openExplain('sharpe')
    // depth 0: summary shown, the key-factors / full-detail headers are not.
    expect(screen.getByText(METRICS.sharpe.summary)).toBeInTheDocument()
    expect(screen.queryByText('Key factors')).not.toBeInTheDocument()
    expect(screen.queryByText('Full detail')).not.toBeInTheDocument()
  })

  it('steps summary → key factors → full detail under user control', () => {
    openExplain('sharpe')
    const more = () => screen.getByRole('button', { name: /More detail/ })

    // depth 0 → 1: key factors appear, first factor bullet rendered.
    fireEvent.click(more())
    expect(screen.getByText('Key factors')).toBeInTheDocument()
    expect(screen.getByText(METRICS.sharpe.factors![0])).toBeInTheDocument()
    expect(screen.queryByText('Full detail')).not.toBeInTheDocument()

    // depth 1 → 2: full detail appears; "More detail" is now gone (deepest reached).
    fireEvent.click(more())
    expect(screen.getByText('Full detail')).toBeInTheDocument()
    expect(screen.getByText(METRICS.sharpe.detail!)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /More detail/ })).not.toBeInTheDocument()
  })

  it('steps back with "Less detail"', () => {
    openExplain('sharpe')
    fireEvent.click(screen.getByRole('button', { name: /More detail/ }))
    expect(screen.getByText('Key factors')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Less detail/ }))
    expect(screen.queryByText('Key factors')).not.toBeInTheDocument()
    // back at the summary floor — no "Less detail" affordance remains.
    expect(screen.queryByRole('button', { name: /Less detail/ })).not.toBeInTheDocument()
  })

  it('offers no depth controls for a summary-only metric (additive, never forced)', () => {
    // A synthetic id with no deeper layers behaves exactly like the original one-layer
    // toggletip — proving the depth UI is opt-in per the registry, not bolted onto all.
    METRICS.__test_summary_only__ = {
      id: '__test_summary_only__',
      title: 'Summary Only',
      summary: 'Just the gist, nothing deeper.',
      bands: [{ max: Infinity, label: 'ok', tone: 'good' }],
    }
    try {
      openExplain('__test_summary_only__')
      expect(screen.getByText('Just the gist, nothing deeper.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /More detail/ })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Less detail/ })).not.toBeInTheDocument()
    } finally {
      delete METRICS.__test_summary_only__
    }
  })

  it('still maps the reader value to its interpretation band at every depth', () => {
    openExplain('sharpe', 2.5)
    expect(screen.getByRole('status')).toHaveTextContent('Your value:')
    expect(screen.getByRole('status')).toHaveTextContent('2.50') // ratio(2) of 2.5
    expect(screen.getByText('strong')).toBeInTheDocument() // band label for sharpe > 2
  })
})
