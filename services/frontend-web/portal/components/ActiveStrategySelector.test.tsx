// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Card #50 (epic-portal-post-redesign-fixes Task 5): selecting a different strategy and saving
// must visibly reflect the change. The backend applies live synchronously (repro: appliedLive=true
// and /admin/api/strategy/{status,config} both move immediately), so the only defect was the
// selector never calling router.refresh() — the SSR-static "Currently running" line never re-seeded.
// These tests pin the fix: a successful PUT calls router.refresh() (re-runs the StrategyTab server
// component → re-seeds the line), the confirm dialog still gates the write, and the appliedLive
// false / failure paths are rendered honestly and do NOT refresh on error.
//
// Seams mocked: useRouter (no App Router runtime in jsdom), window.confirm (the mutate gate),
// and global fetch (no live ingress in a unit test).

const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}))

import { ActiveStrategySelector } from './ActiveStrategySelector'

const STRATEGIES = ['high_velocity_v1', 'sector_momentum_v1', 'factor_rank_v1']

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('ActiveStrategySelector', () => {
  it('seeds the "Currently running" line from the active prop', () => {
    render(<ActiveStrategySelector strategies={STRATEGIES} active="high_velocity_v1" />)
    // The active id appears in both the <option> and the "Currently running" span; assert the
    // line specifically (the bug was this line not moving after a save).
    expect(screen.getByText(/Currently running:/i)).toHaveTextContent('Currently running: high_velocity_v1')
  })

  it('on a successful applied-live PUT, calls router.refresh() so the line re-seeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, selected: 'sector_momentum_v1', applied: 'sector_momentum_v1', appliedLive: true }))
    vi.stubGlobal('fetch', fetchMock)

    render(<ActiveStrategySelector strategies={STRATEGIES} active="high_velocity_v1" />)
    await act(async () => {
      screen.getByRole('button', { name: /set active/i }).click()
    })

    // PUT went to the portal-api proxy with the selected id.
    expect(fetchMock).toHaveBeenCalledWith(
      '/portal-api/admin/strategy/active',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ strategy_id: 'high_velocity_v1' }) }),
    )
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/Applied live/i)).toBeInTheDocument()
  })

  it('does not PUT or refresh when the confirm dialog is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    render(<ActiveStrategySelector strategies={STRATEGIES} active="high_velocity_v1" />)
    await act(async () => {
      screen.getByRole('button', { name: /set active/i }).click()
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('renders the not-yet-applied case honestly and still refreshes (so the persisted choice shows)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, selected: 'sector_momentum_v1', applied: 'high_velocity_v1', appliedLive: false }))
    vi.stubGlobal('fetch', fetchMock)

    render(<ActiveStrategySelector strategies={STRATEGIES} active="high_velocity_v1" />)
    await act(async () => {
      screen.getByRole('button', { name: /set active/i }).click()
    })

    expect(await screen.findByText(/not yet applied live/i)).toBeInTheDocument()
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))
  })

  it('shows the error and does NOT refresh on a failed PUT', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'unknown strategy_id' }, false, 400))
    vi.stubGlobal('fetch', fetchMock)

    render(<ActiveStrategySelector strategies={STRATEGIES} active="high_velocity_v1" />)
    await act(async () => {
      screen.getByRole('button', { name: /set active/i }).click()
    })

    expect(await screen.findByText(/unknown strategy_id/i)).toBeInTheDocument()
    expect(refreshMock).not.toHaveBeenCalled()
  })
})
