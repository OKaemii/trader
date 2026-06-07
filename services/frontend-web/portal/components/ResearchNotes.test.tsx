// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// research-trading-os Task 34 §G — the notebook editor/preview. These pin the contract a logged-in
// operator relies on: write/preview toggle renders the markdown via <Markdown>, a save PUTs the body
// and calls router.refresh() (so the SSR-seeded Backlinks elsewhere re-derive), confirm-before-
// overwrite gates a save over an existing note, and delete confirms + clears. The proxy + Markdown
// are mocked (no live ingress / no react-markdown ESM in a unit test).

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock }),
}))

// Stub the sanitized renderer (its own test owns the sanitize contract) so the preview assertion
// doesn't depend on react-markdown internals — we only verify the body text reaches the preview.
vi.mock('@/components/ui/Markdown', () => ({
  Markdown: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}))

import { ResearchNotes, type ResearchNote } from './ResearchNotes'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

const EMPTY: ResearchNote = { ticker: 'AAPL_US_EQ', body: '', links: [], updatedBy: null, updatedAt: null }
const SAVED: ResearchNote = {
  ticker: 'AAPL_US_EQ',
  body: 'Old thesis on @strategy:factor_rank_v1',
  links: [{ kind: 'strategy', ref: 'factor_rank_v1' }],
  updatedBy: 'okaemii',
  updatedAt: 1_700_000_000_000,
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('ResearchNotes', () => {
  it('seeds the editor from the initial note body', () => {
    render(<ResearchNotes ticker="AAPL_US_EQ" initial={SAVED} />)
    expect(screen.getByRole('textbox')).toHaveValue('Old thesis on @strategy:factor_rank_v1')
    // Server-parsed links are shown on the full panel.
    expect(screen.getByText('@strategy:factor_rank_v1')).toBeInTheDocument()
  })

  it('renders the draft through <Markdown> in preview view', () => {
    render(<ResearchNotes ticker="AAPL_US_EQ" initial={SAVED} />)
    fireEvent.click(screen.getByRole('button', { name: /preview/i }))
    expect(screen.getByTestId('md')).toHaveTextContent('Old thesis on @strategy:factor_rank_v1')
  })

  it('first save of a blank note skips the confirm and PUTs the body, then refreshes', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse({ ...EMPTY, body: 'hi', updatedAt: 1, updatedBy: 'x' }))
    render(<ResearchNotes ticker="AAPL_US_EQ" initial={EMPTY} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: /save note/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // No confirm for a first save (nothing to overwrite).
    expect(window.confirm).not.toHaveBeenCalled()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/portal-api/admin/research/notes/AAPL_US_EQ')
    expect(opts?.method).toBe('PUT')
    expect(JSON.parse(opts?.body as string)).toEqual({ body: 'hi' })
    await waitFor(() => expect(refreshMock).toHaveBeenCalled())
  })

  it('overwriting an existing note confirms first; cancelling blocks the PUT', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(SAVED))
    render(<ResearchNotes ticker="AAPL_US_EQ" initial={SAVED} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new body' } })
    fireEvent.click(screen.getByRole('button', { name: /save note/i }))

    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('delete confirms, DELETEs, clears the editor and refreshes', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse({ ticker: 'AAPL_US_EQ', deleted: true }))
    render(<ResearchNotes ticker="AAPL_US_EQ" initial={SAVED} />)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(window.confirm).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/portal-api/admin/research/notes/AAPL_US_EQ')
    expect(opts?.method).toBe('DELETE')
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
    expect(refreshMock).toHaveBeenCalled()
  })

  it('keeps the editor populated and shows an error when the save fails', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ error: 'nope' }, false, 500))
    render(<ResearchNotes ticker="AAPL_US_EQ" initial={EMPTY} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft' } })
    fireEvent.click(screen.getByRole('button', { name: /save note/i }))

    await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument())
    expect(screen.getByRole('textbox')).toHaveValue('draft')
    expect(refreshMock).not.toHaveBeenCalled()
  })
})
