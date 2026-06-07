// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DrawerProvider, useResearchDrawer } from './ResearchDrawer'

// Task 1's required local smoke: the universal research drawer opens on a symbol,
// closes via the close button, and closes on Escape — driven through the real
// <DrawerProvider> context + useResearchDrawer() seam that ⌘K (T21) and the drawer
// body (T35) will consume.

// A tiny control surface so the test can drive open()/close() without a real
// trigger component existing yet.
function Controls() {
  const { open, close, isOpen, symbol } = useResearchDrawer()
  return (
    <div>
      <button onClick={() => open('AAPL')}>open-aapl</button>
      <button onClick={close}>close</button>
      <span>state:{isOpen ? `open:${symbol}` : 'closed'}</span>
    </div>
  )
}

function renderDrawer() {
  return render(
    <DrawerProvider>
      <Controls />
    </DrawerProvider>,
  )
}

describe('ResearchDrawer / useResearchDrawer', () => {
  it('starts closed', () => {
    renderDrawer()
    expect(screen.getByText('state:closed')).toBeInTheDocument()
    expect(screen.queryByText('AAPL')).not.toBeInTheDocument()
  })

  it('open(symbol) shows the drawer with that symbol', () => {
    renderDrawer()
    fireEvent.click(screen.getByText('open-aapl'))
    expect(screen.getByText('state:open:AAPL')).toBeInTheDocument()
    // The Radix dialog title renders the symbol.
    expect(screen.getByRole('dialog')).toHaveTextContent('AAPL')
  })

  it('close() hides the drawer', () => {
    renderDrawer()
    fireEvent.click(screen.getByText('open-aapl'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByText('close'))
    expect(screen.getByText('state:closed')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Escape closes the drawer (inherited focus-trap behaviour)', () => {
    renderDrawer()
    fireEvent.click(screen.getByText('open-aapl'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
    expect(screen.getByText('state:closed')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('useResearchDrawer throws outside a <DrawerProvider>', () => {
    function Orphan() {
      useResearchDrawer()
      return null
    }
    expect(() => render(<Orphan />)).toThrow(/must be used within a <DrawerProvider>/)
  })
})
