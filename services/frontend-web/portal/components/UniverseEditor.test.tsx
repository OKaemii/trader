// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UniverseEditor } from './UniverseEditor'
import type { UniverseOverrides } from '@/app/actions/admin'

// The forced-add/remove editor, flipped to the BARE ticker model (epic
// pit-fundamentals-lake-rearchitecture, Task 21): the operator types a bare symbol + picks a market;
// entries render as SYMBOL + a market badge (no _US_EQ); Save posts the bare {symbol, market} objects.

// vi.hoisted so the mock fns exist before the (hoisted) vi.mock factory runs.
const { saveMock, refreshMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  refreshMock: vi.fn(),
}))

vi.mock('@/app/actions/admin', () => ({
  saveUniverseOverrides: saveMock,
  refreshUniverse: refreshMock,
}))

const initial: UniverseOverrides = {
  adds: [{ symbol: 'NVDA', market: 'US' }],
  removes: [{ symbol: 'SGLN', market: 'LSE' }],
  activeUniverse: [],
  updatedBy: 'OKaemii',
  updatedAt: '2026-06-13T00:00:00Z',
}

beforeEach(() => {
  saveMock.mockResolvedValue({ ok: true, status: 200 })
  refreshMock.mockResolvedValue({ ok: true, universeSize: 100 })
})

afterEach(() => {
  vi.restoreAllMocks()
  saveMock.mockReset()
  refreshMock.mockReset()
})

describe('UniverseEditor — bare-ticker forced adds/removes (Task 21)', () => {
  it('renders existing entries as bare SYMBOL + a market badge (no _US_EQ / l_EQ)', () => {
    render(<UniverseEditor initial={initial} />)
    // bare symbols are shown
    expect(screen.getByText('NVDA')).toBeInTheDocument()
    expect(screen.getByText('SGLN')).toBeInTheDocument()
    // the broker suffix is never rendered
    expect(screen.queryByText(/_US_EQ/)).not.toBeInTheDocument()
    expect(screen.queryByText(/l_EQ/)).not.toBeInTheDocument()
    // the market is disambiguated with a badge (US for NVDA, LSE for SGLN)
    expect(screen.getAllByText('US').length).toBeGreaterThan(0)
    expect(screen.getAllByText('LSE').length).toBeGreaterThan(0)
  })

  it('the forced-add input + market selector accept a bare symbol and add it as {symbol, market}', () => {
    render(<UniverseEditor initial={{ ...initial, adds: [] }} />)
    const addInput = screen.getByLabelText('Forced adds symbol')
    fireEvent.change(addInput, { target: { value: 'googl' } })
    // default market is US — no need to touch the selector
    fireEvent.submit(addInput.closest('form')!)
    // the new entry renders bare + upper-cased
    expect(screen.getByText('GOOGL')).toBeInTheDocument()
  })

  it('honours the market selector for a bare add (LSE)', () => {
    render(<UniverseEditor initial={{ ...initial, adds: [] }} />)
    const addInput = screen.getByLabelText('Forced adds symbol')
    const addMarket = screen.getByLabelText('Forced adds market')
    fireEvent.change(addMarket, { target: { value: 'LSE' } })
    fireEvent.change(addInput, { target: { value: 'shel' } })
    fireEvent.submit(addInput.closest('form')!)
    const shel = screen.getByText('SHEL').closest('li')!
    expect(within(shel).getByText('LSE')).toBeInTheDocument()
  })

  it('Save posts the BARE {symbol, market} objects (adds + removes)', async () => {
    render(<UniverseEditor initial={{ ...initial, adds: [] }} />)
    // add GOOGL (US)
    const addInput = screen.getByLabelText('Forced adds symbol')
    fireEvent.change(addInput, { target: { value: 'GOOGL' } })
    fireEvent.submit(addInput.closest('form')!)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    const [adds, removes] = saveMock.mock.calls[0]
    expect(adds).toEqual([{ symbol: 'GOOGL', market: 'US' }])
    // the initial LSE remove is posted as a bare object too
    expect(removes).toEqual([{ symbol: 'SGLN', market: 'LSE' }])
  })

  it('a pasted legacy T212 string is normalised to a bare identity (suffix market wins)', () => {
    // a clean board (no SGLN remove) so the pasted entry is the only SGLN row
    render(<UniverseEditor initial={{ ...initial, adds: [], removes: [] }} />)
    const addInput = screen.getByLabelText('Forced adds symbol')
    // even with the selector on US (the default), a pasted LSE T212 string lands on LSE
    fireEvent.change(addInput, { target: { value: 'SGLNl_EQ' } })
    fireEvent.submit(addInput.closest('form')!)
    const sgln = screen.getByText('SGLN').closest('li')!
    expect(within(sgln).getByText('LSE')).toBeInTheDocument()
  })

  it('de-dups an add already present on the same (symbol, market)', () => {
    render(<UniverseEditor initial={{ ...initial, adds: [{ symbol: 'GOOGL', market: 'US' }] }} />)
    const addInput = screen.getByLabelText('Forced adds symbol')
    fireEvent.change(addInput, { target: { value: 'googl' } })
    fireEvent.submit(addInput.closest('form')!)
    // still a single GOOGL entry
    expect(screen.getAllByText('GOOGL')).toHaveLength(1)
  })

  it('removes an entry when its × is clicked', () => {
    render(<UniverseEditor initial={initial} />)
    expect(screen.getByText('NVDA')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Remove NVDA (US)'))
    expect(screen.queryByText('NVDA')).not.toBeInTheDocument()
  })
})
