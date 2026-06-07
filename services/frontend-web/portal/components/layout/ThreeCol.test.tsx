// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

// Task 19 (epic-research-trading-os): the ThreeCol layout is the reusable LHS·center·RHS skeleton
// behind the Workspace hero + rail, and is reused by Research/dense lists (T31 mounts a panel into a
// rail slot; T38 reuses the layout). These tests pin the contract those consumers depend on: the
// center always renders, an absent rail collapses its track (no ghost gutter), and the stacked
// source order is controllable.
import { ThreeCol } from './ThreeCol'

const tracks = (el: HTMLElement | null) =>
  el?.style.getPropertyValue('--three-col-tracks') ?? ''

describe('ThreeCol', () => {
  it('always renders the center content', () => {
    render(<ThreeCol center={<div>focus body</div>} />)
    expect(screen.getByText('focus body')).toBeInTheDocument()
  })

  it('renders DOM children in left·center·right order so they line up with the track list', () => {
    render(
      <ThreeCol
        left={<div>left rail</div>}
        center={<div>center body</div>}
        right={<div>right rail</div>}
      />,
    )
    const grid = screen.getByTestId('three-col')
    const texts = within(grid)
      .getAllByText(/left rail|center body|right rail/)
      .map((n) => n.textContent)
    // DOM order MUST be left·center·right to match `tracks` (1fr 2fr 1fr) at xl — otherwise grid
    // auto-placement would drop the wide center into a narrow rail track. The mobile stack order is
    // decoupled below.
    expect(texts).toEqual(['left rail', 'center body', 'right rail'])
  })

  it('stacks center first on mobile by default (focus paints first), via an order utility', () => {
    render(
      <ThreeCol left={<div>left rail</div>} center={<div>center body</div>} />,
    )
    // The center <section> carries the below-xl order override so it leads the single-column stack
    // even though it sits second in the DOM (so the xl grid placement stays correct).
    const center = screen.getByText('center body').parentElement
    expect(center).toHaveClass('max-xl:order-first')
  })

  it('keeps natural source order on mobile when railsFirst is set (no order override)', () => {
    render(
      <ThreeCol railsFirst left={<div>left rail</div>} center={<div>center body</div>} />,
    )
    const center = screen.getByText('center body').parentElement
    expect(center).not.toHaveClass('max-xl:order-first')
  })

  it('collapses an absent rail to no track (center + one rail only)', () => {
    render(<ThreeCol center={<div>c</div>} right={<div>r</div>} />)
    const grid = screen.getByTestId('three-col')
    // Only center (2fr) + right (1fr) tracks — no leading 1fr ghost for the missing left rail.
    expect(tracks(grid)).toBe('2fr 1fr')
    // The left <aside> is not rendered at all.
    expect(screen.queryByText('left')).not.toBeInTheDocument()
  })

  it('emits a 1fr·2fr·1fr track list when both rails are present', () => {
    render(<ThreeCol left={<div>l</div>} center={<div>c</div>} right={<div>r</div>} />)
    expect(tracks(screen.getByTestId('three-col'))).toBe('1fr 2fr 1fr')
  })

  it('honours a custom centerSpan (clamped to ≥1)', () => {
    const { rerender } = render(
      <ThreeCol left={<div>l</div>} center={<div>c</div>} centerSpan={3} />,
    )
    expect(tracks(screen.getByTestId('three-col'))).toBe('1fr 3fr')
    // A span below 1 is clamped so the center never collapses below a rail.
    rerender(<ThreeCol left={<div>l</div>} center={<div>c</div>} centerSpan={0} />)
    expect(tracks(screen.getByTestId('three-col'))).toBe('1fr 1fr')
  })

  it('keeps the left·center·right DOM order regardless of railsFirst (only mobile order differs)', () => {
    render(
      <ThreeCol
        railsFirst
        left={<div>left rail</div>}
        center={<div>center body</div>}
        right={<div>right rail</div>}
      />,
    )
    const grid = screen.getByTestId('three-col')
    const texts = within(grid)
      .getAllByText(/left rail|center body|right rail/)
      .map((n) => n.textContent)
    // DOM order is invariant (xl grid placement must stay correct); railsFirst only changes the
    // below-xl stacking, asserted separately via the order utility.
    expect(texts).toEqual(['left rail', 'center body', 'right rail'])
  })
})
