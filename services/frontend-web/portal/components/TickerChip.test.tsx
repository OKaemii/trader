// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DrawerProvider, useResearchDrawer } from './ResearchDrawer'
import { TickerChip } from './TickerChip'

// Task 36's required local smoke: the universal cross-link affordance. A <TickerChip> rendered
// anywhere under the <DrawerProvider> opens the in-context research drawer on its symbol WITHOUT
// a navigation — exactly the open(symbol) contract every surface (signal feed, holdings, positions,
// universe rows, scanner constituents) now wires through this one component.

// Surfaces the live drawer state next to the chip so the test can assert the click opened it.
function DrawerState() {
  const { isOpen, symbol } = useResearchDrawer()
  return <span>state:{isOpen ? `open:${symbol}` : 'closed'}</span>
}

describe('TickerChip', () => {
  it('renders the symbol as its label by default', () => {
    render(
      <DrawerProvider>
        <TickerChip symbol="AAPL_US_EQ" />
      </DrawerProvider>,
    )
    expect(screen.getByRole('button', { name: /AAPL_US_EQ/ })).toBeInTheDocument()
  })

  it('clicking opens the research drawer on its symbol (no navigation)', () => {
    render(
      <DrawerProvider>
        <DrawerState />
        <TickerChip symbol="AAPL_US_EQ" />
      </DrawerProvider>,
    )
    expect(screen.getByText('state:closed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /AAPL_US_EQ/ }))
    expect(screen.getByText('state:open:AAPL_US_EQ')).toBeInTheDocument()
    // The drawer overlay (Radix dialog) surfaces, titled with the symbol.
    expect(screen.getByRole('dialog')).toHaveTextContent('AAPL_US_EQ')
  })

  it('renders custom children as the label while still opening on the symbol', () => {
    render(
      <DrawerProvider>
        <DrawerState />
        <TickerChip symbol="VOD_l_EQ">
          <span>VOD</span>
        </TickerChip>
      </DrawerProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /VOD/ }))
    // The canonical id (not the visible short label) is what opens the drawer.
    expect(screen.getByText('state:open:VOD_l_EQ')).toBeInTheDocument()
  })

  it('throws when used outside a <DrawerProvider> (a wiring bug surfaces locally)', () => {
    expect(() => render(<TickerChip symbol="AAPL_US_EQ" />)).toThrow(
      /must be used within a <DrawerProvider>/,
    )
  })
})
