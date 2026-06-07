'use client'
// Backlinks — "notes referencing this entity" (research-trading-os Task 34 §G). Surfaced on the
// signal-detail (kind=signal) and Build·Strategy (kind=strategy) views: any research note whose body
// `@`-mentions this entity shows up here, so an operator reading a strategy/signal sees the notebook
// context written about it. Backed by GET /portal-api/admin/research/notes/backlinks?kind=&ref= (T33),
// SSR-seeded so the list renders on first paint.
//
//   <Backlinks kind="strategy" ref_="factor_rank_v1" initial={notes} />
//
// Each referrer note is ABOUT a `ticker` (the note's subject symbol) — we deep-link the title to that
// symbol's Research overview so the operator can jump to the full note + editor. We re-fetch on mount
// once so a note saved elsewhere (then this page router.refresh()ed) reflects without a hard reload;
// the SSR seed means there's no empty flash before that.
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { ResearchLink } from '@/components/ResearchNotes'

/** A referrer note as served by the backlinks endpoint (full body + parsed links). */
export interface BacklinkNote {
  ticker: string
  body: string
  links: ResearchLink[]
  updatedBy: string | null
  updatedAt: number | null
}

/** First non-blank line of the body as a one-line summary (markdown heading marks stripped). */
function summarise(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0) ?? ''
  return line.replace(/^#{1,6}\s*/, '').trim()
}

function fmtWhen(updatedAt: number | null): string {
  if (updatedAt === null) return ''
  const d = new Date(updatedAt)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

export function Backlinks({
  kind,
  // `ref` is reserved (React forwards a `ref`); name the prop `ref_` and map it onto the query.
  ref_,
  initial,
}: {
  kind: 'strategy' | 'signal' | 'symbol'
  ref_: string
  initial: BacklinkNote[]
}) {
  const [notes, setNotes] = useState<BacklinkNote[]>(initial)

  useEffect(() => {
    let cancelled = false
    const qs = new URLSearchParams({ kind, ref: ref_ }).toString()
    fetch(`/portal-api/admin/research/notes/backlinks?${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { notes?: BacklinkNote[] } | null) => {
        if (!cancelled && data && Array.isArray(data.notes)) setNotes(data.notes)
      })
      .catch(() => {
        /* keep the SSR seed on a transient miss — never blank an already-rendered list */
      })
    return () => {
      cancelled = true
    }
  }, [kind, ref_])

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-gray-300">
        Research notes referencing this {kind}
      </h2>
      {notes.length === 0 ? (
        <p className="text-sm text-gray-500">
          No research notes mention this {kind} yet. Add{' '}
          <code className="font-mono text-gray-400">@{kind}:{ref_}</code> to a note to link it here.
        </p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => {
            const summary = summarise(n.body)
            const when = fmtWhen(n.updatedAt)
            return (
              <li key={n.ticker} className="rounded border border-gray-800 bg-gray-900 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/research?symbol=${encodeURIComponent(n.ticker)}`}
                    className="font-mono text-sm text-emerald-400 hover:text-emerald-300 hover:underline"
                  >
                    {n.ticker}
                  </Link>
                  {when && <span className="text-[10px] text-gray-500">{when}</span>}
                </div>
                {summary && <p className="mt-1 truncate text-xs text-gray-400">{summary}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export default Backlinks
