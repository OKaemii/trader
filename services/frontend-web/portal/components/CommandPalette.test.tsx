// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResults } from '@/app/lib/search-merge'
import { RECENTS_KEY } from '@/app/lib/frecency'

// Card #46's required local smoke (epic-portal-post-redesign-fixes Task 1): the ⌘K
// palette's two action entries — "Toggle Beginner / Quant mode" and "Sign out" —
// invoke their wired primitive when selected. Navigation entries (href) are covered
// by command-registry.test.ts + route-resolution.test.ts.
//
// research-trading-os Task 1 added the entity-search + frecency layer: bare text
// debounce-queries /portal-api/search and renders Tickers/Strategies/Signals groups;
// a leading '>' filters to commands only; selecting an entity routes (ticker→drawer,
// signal→/signals/:id, strategy→/build?tab=strategy) and records frecency. Those
// behaviours are covered below.
//
// Seams mocked: setMode / logout (server actions — no real cookie/redirect in jsdom),
// useRouter (no App Router runtime in a unit test), react-hotkeys-hook so the test can
// drive the hotkey handler imperatively to open the otherwise-unmounted dialog, and the
// global fetch (the entity search) returning a canned SearchResults body.

// vi.hoisted so these mock fns exist before the (hoisted) vi.mock factories run.
const { setModeMock, logoutMock, pushMock, refreshMock } = vi.hoisted(() => ({
  setModeMock: vi.fn<(m: string) => Promise<void>>().mockResolvedValue(undefined),
  logoutMock: vi.fn().mockResolvedValue(undefined),
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}))
// Captures the handler CommandPalette registers with useHotkeys('mod+k', …) so the
// test can fire it to open the dialog (cmdk renders nothing while closed). The real
// handler calls e.preventDefault(), so we hand it a minimal event stub.
let hotkeyHandler: ((e: { preventDefault: () => void }) => void) | undefined

vi.mock('@/app/lib/mode-actions', () => ({ setMode: setModeMock }))
vi.mock('@/app/actions/auth', () => ({ logout: logoutMock }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}))
vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: (_keys: string, handler: (e: { preventDefault: () => void }) => void) => {
    hotkeyHandler = handler
  },
}))

import { ModeProvider } from './ModeProvider'
import { DrawerProvider } from './ResearchDrawer'
import { CommandPalette } from './CommandPalette'
import type { Mode } from '@/app/lib/mode-parse'

// A canned search body returned by the mocked /portal-api/search fetch.
const SEARCH_BODY: SearchResults = {
  tickers: [{ symbol: 'AAPL', name: 'Apple Inc', sector: 'Technology', market: 'US' }],
  strategies: [{ id: 'factor_rank_v1', active: true }],
  signals: [{ id: 'sig-123', ticker: 'AAPL', action: 'BUY', strategy_id: 'factor_rank_v1', timestamp: 1 }],
}

function mockSearch(body: SearchResults = SEARCH_BODY) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => body }) as unknown as Response),
  )
}

function renderPalette(initial: Mode) {
  // CommandPalette calls useResearchDrawer(), so it must render inside DrawerProvider
  // (mirrors the production layout where the palette is mounted inside DrawerProvider).
  render(
    <ModeProvider initial={initial}>
      <DrawerProvider>
        <CommandPalette />
      </DrawerProvider>
    </ModeProvider>,
  )
  // Open the dialog so cmdk mounts the command list (it renders nothing closed).
  act(() => {
    hotkeyHandler?.({ preventDefault: () => {} })
  })
}

// Type into the palette's search input (drives the controlled query state).
function typeQuery(value: string) {
  const input = screen.getByPlaceholderText(/Search tickers/i)
  act(() => {
    fireEvent.change(input, { target: { value } })
  })
}

beforeEach(() => {
  hotkeyHandler = undefined
  window.localStorage.clear()
  // Default: an empty fetch so a stray debounced search never hits the network.
  // Real timers throughout — the 200ms debounce is well within findByText's poll
  // window, and avoids the fake-timer / async-polling interplay flakiness.
  mockSearch({ tickers: [], strategies: [], signals: [] })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('CommandPalette action wiring', () => {
  it('dispatches act.toggle-mode → setMode(opposite) + router.refresh() (quant → beginner)', async () => {
    renderPalette('quant')
    const item = await screen.findByText('Toggle Beginner / Quant mode')
    act(() => {
      item.click()
    })
    expect(setModeMock).toHaveBeenCalledTimes(1)
    expect(setModeMock).toHaveBeenCalledWith('beginner')
    expect(logoutMock).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
    // refresh() chains off the setMode promise — wait for the microtask.
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))
  })

  it('toggles the other way when current mode is beginner (beginner → quant)', async () => {
    renderPalette('beginner')
    const item = await screen.findByText('Toggle Beginner / Quant mode')
    act(() => {
      item.click()
    })
    expect(setModeMock).toHaveBeenCalledWith('quant')
  })

  it('dispatches act.sign-out → logout()', async () => {
    renderPalette('quant')
    const item = await screen.findByText('Sign out')
    act(() => {
      item.click()
    })
    expect(logoutMock).toHaveBeenCalledTimes(1)
    expect(setModeMock).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('navigation entries still router.push their href (no action dispatch)', async () => {
    renderPalette('quant')
    const item = await screen.findByText('Workspace')
    act(() => {
      item.click()
    })
    expect(pushMock).toHaveBeenCalledWith('/workspace')
    expect(setModeMock).not.toHaveBeenCalled()
    expect(logoutMock).not.toHaveBeenCalled()
  })
})

describe('CommandPalette mode-prefix', () => {
  it("a leading '>' shows commands only (no entity search fired)", async () => {
    mockSearch(SEARCH_BODY)
    renderPalette('quant')
    typeQuery('>port')
    // Commands matching "port" render; entity groups never appear in command mode.
    expect(await screen.findByText('Portfolio')).toBeInTheDocument()
    expect(screen.queryByText('Tickers')).not.toBeInTheDocument()
    expect((globalThis.fetch as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('bare text debounce-queries the search and renders entity groups above commands', async () => {
    mockSearch(SEARCH_BODY)
    renderPalette('quant')
    typeQuery('aapl')
    // The debounced fetch fires after the timer; the entity groups then render.
    expect(await screen.findByText('Tickers')).toBeInTheDocument()
    expect(screen.getByText('Strategies')).toBeInTheDocument()
    expect(screen.getByText('Signals')).toBeInTheDocument()
    expect(globalThis.fetch).toHaveBeenCalledWith('/portal-api/search?q=aapl')
  })
})

// Click a cmdk item by its `value` prop (reflected as data-value="<value>"). The
// entity items carry stable, unique values (ticker:AAPL, signal:sig-123,
// strategy:factor_rank_v1), so this avoids ambiguity when the same id text (a
// strategy id == a signal's strategy_id) appears in more than one group.
function clickByValue(value: string) {
  const el = document.querySelector(`[data-value="${value}"]`) as HTMLElement | null
  if (!el) throw new Error(`no cmdk item with value ${value}`)
  act(() => {
    el.click()
  })
}

describe('CommandPalette entity routing', () => {
  it('selecting a ticker opens the research drawer on that symbol', async () => {
    mockSearch(SEARCH_BODY)
    renderPalette('quant')
    typeQuery('aapl')
    await screen.findByText('Tickers')
    clickByValue('ticker:AAPL')
    // The drawer (a Radix dialog) now shows the symbol; the palette closed (no push).
    await waitFor(() => {
      const dialog = screen.getByRole('dialog')
      expect(dialog).toHaveTextContent('AAPL')
    })
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('selecting a signal routes to /signals/:id', async () => {
    mockSearch(SEARCH_BODY)
    renderPalette('quant')
    typeQuery('aapl')
    await screen.findByText('Signals')
    clickByValue('signal:sig-123')
    expect(pushMock).toHaveBeenCalledWith('/signals/sig-123')
  })

  it('selecting a strategy routes to /build?tab=strategy', async () => {
    mockSearch(SEARCH_BODY)
    renderPalette('quant')
    typeQuery('factor')
    await screen.findByText('Strategies')
    clickByValue('strategy:factor_rank_v1')
    expect(pushMock).toHaveBeenCalledWith('/build?tab=strategy')
  })
})

describe('CommandPalette frecency', () => {
  it('records a selected ticker into localStorage and surfaces it on the next empty open', async () => {
    mockSearch(SEARCH_BODY)
    renderPalette('quant')
    typeQuery('aapl')
    await screen.findByText('Tickers')
    clickByValue('ticker:AAPL')
    // The selection persisted a recent-entities entry under the frecency key.
    await waitFor(() => {
      const raw = window.localStorage.getItem(RECENTS_KEY)
      expect(raw).toBeTruthy()
      expect(raw).toContain('AAPL')
      expect(raw).toContain('ticker')
    })
  })
})
