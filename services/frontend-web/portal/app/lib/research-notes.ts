import { authedFetch } from '@/app/lib/auth-fetch'
import type { ResearchNote } from '@/components/ResearchNotes'
import type { BacklinkNote } from '@/components/Backlinks'

// Server-side seed helpers for the research notebook (research-trading-os Task 34 §G). Server
// components call these to SSR-seed the client ResearchNotes editor + Backlinks lists (the portal's
// no-flicker SSR-seed + client-mutate pattern), so the panels render populated on first paint.
// Both degrade to an honest empty shape on any failure — a transient note-store miss must never
// blank or 500 the page the notebook is embedded in.

/** GET the note for an entity. Missing-note is a 200 empty shape upstream; we mirror that on failure. */
export async function fetchResearchNote(ticker: string): Promise<ResearchNote> {
  const empty: ResearchNote = { ticker, body: '', links: [], updatedBy: null, updatedAt: null }
  try {
    const r = await authedFetch(`/admin/api/research/notes/${encodeURIComponent(ticker)}`)
    if (!r.ok) return empty
    const data = (await r.json().catch(() => null)) as Partial<ResearchNote> | null
    if (!data || typeof data.body !== 'string') return empty
    return {
      ticker: typeof data.ticker === 'string' ? data.ticker : ticker,
      body: data.body,
      links: Array.isArray(data.links) ? data.links : [],
      updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : null,
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : null,
    }
  } catch {
    return empty
  }
}

/** GET notes referencing entity (kind, ref) — "backlinks". Degrades to [] on any failure. */
export async function fetchBacklinks(
  kind: 'strategy' | 'signal' | 'symbol',
  ref: string,
): Promise<BacklinkNote[]> {
  try {
    const qs = new URLSearchParams({ kind, ref }).toString()
    const r = await authedFetch(`/admin/api/research/notes/backlinks?${qs}`)
    if (!r.ok) return []
    const data = (await r.json().catch(() => null)) as { notes?: BacklinkNote[] } | null
    return Array.isArray(data?.notes) ? data.notes : []
  } catch {
    return []
  }
}
