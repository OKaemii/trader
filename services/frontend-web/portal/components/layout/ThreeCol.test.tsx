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

  it('renders both rails when provided, in left·center·right DOM order by default', () => {
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
    // Default (railsFirst=false) stacks center first; both rails still present and ordered after.
    expect(texts).toEqual(['center body', 'left rail', 'right rail'])
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

  it('renders rails before the center when railsFirst is set', () => {
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
    expect(texts).toEqual(['left rail', 'center body', 'right rail'])
  })
})
