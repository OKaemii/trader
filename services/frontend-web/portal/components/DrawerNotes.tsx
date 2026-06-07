'use client'
// The drawer's notes panel (research-trading-os Task 34 §G). The universal ResearchDrawer is a
// CLIENT component — it can't call the server-only authedFetch to SSR-seed the note the way the
// Overview tab does — so this thin wrapper client-fetches the note through the proxy on open, then
// hands it to the shared <ResearchNotes compact> editor. Kept as its own component so the drawer
// touch stays a single self-contained slot (Task 35 fills the rest of the drawer body around it).
//
//   <DrawerNotes ticker={symbol} />
//
// Mounted with a key={symbol} by the drawer so it remounts (re-fetches) when the symbol changes.
import { useEffect, useState } from 'react'
import { ResearchNotes, type ResearchNote } from '@/components/ResearchNotes'

export function DrawerNotes({ ticker }: { ticker: string }) {
  const [note, setNote] = useState<ResearchNote | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/portal-api/admin/research/notes/${encodeURIComponent(ticker)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Partial<ResearchNote> | null) => {
        if (cancelled) return
        setNote({
          ticker,
          body: typeof data?.body === 'string' ? data.body : '',
          links: Array.isArray(data?.links) ? data!.links! : [],
          updatedBy: typeof data?.updatedBy === 'string' ? data.updatedBy : null,
          updatedAt: typeof data?.updatedAt === 'number' ? data.updatedAt : null,
        })
      })
      .catch(() => {
        // On a transient miss, seed a blank note so the operator can still start writing.
        if (!cancelled) setNote({ ticker, body: '', links: [], updatedBy: null, updatedAt: null })
      })
    return () => {
      cancelled = true
    }
  }, [ticker])

  if (note === null) {
    return <p className="text-sm text-gray-500">Loading notes…</p>
  }
  return <ResearchNotes ticker={ticker} initial={note} compact />
}

export default DrawerNotes
