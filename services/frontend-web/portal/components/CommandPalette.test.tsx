// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Card #46's required local smoke (epic-portal-post-redesign-fixes Task 1): the ⌘K
// palette's two action entries — "Toggle Beginner / Quant mode" and "Sign out" —
// invoke their wired primitive when selected. Navigation entries (href) are covered
// by command-registry.test.ts + route-resolution.test.ts; here we prove the no-href
// action branch dispatches by id, the gap this card closes.
//
// Seams mocked: setMode / logout (server actions — no real cookie/redirect in jsdom),
// useRouter (no App Router runtime in a unit test), and react-hotkeys-hook so the test
// can drive the hotkey handler imperatively to open the otherwise-unmounted dialog.

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
import { CommandPalette } from './CommandPalette'
import type { Mode } from '@/app/lib/mode-parse'

function renderPalette(initial: Mode) {
  render(
    <ModeProvider initial={initial}>
      <CommandPalette />
    </ModeProvider>,
  )
  // Open the dialog so cmdk mounts the command list (it renders nothing closed).
  act(() => {
    hotkeyHandler?.({ preventDefault: () => {} })
  })
}

beforeEach(() => {
  hotkeyHandler = undefined
})

afterEach(() => {
  vi.clearAllMocks()
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
