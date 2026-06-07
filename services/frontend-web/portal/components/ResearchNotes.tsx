'use client'
// The research notebook (research-trading-os Task 34 §G): a per-symbol markdown note with a
// write/preview split. Reads + writes the signal-service research store through the portal proxies
// (T33): GET/PUT/DELETE /portal-api/admin/research/notes/:ticker. The body is the source of truth —
// `@<kind>:<ref>` mentions in it are parsed SERVER-SIDE on PUT into the persisted `links` array,
// which drives the backlink index a strategy/signal view surfaces (see Backlinks.tsx).
//
//   <ResearchNotes ticker="AAPL_US_EQ" initial={note} />   // SSR-seeded from the page/drawer
//
// SSR-seed + client-mutate, the portal's no-flicker pattern: the server fetches the note and passes
// it as `initial`, so the editor renders the saved body on first paint with no on-mount GET. After a
// PUT/DELETE we router.refresh() so the SSR-seeded Backlinks elsewhere on the page re-derive from the
// new links (a save that adds `@strategy:factor_rank_v1` must make that strategy's backlinks update).
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { Markdown } from '@/components/ui/Markdown'

/** One parsed `@`-mention. Mirror of signal-service ResearchLink (research/application/ResearchNotes.ts). */
export interface ResearchLink {
  kind: 'strategy' | 'signal' | 'symbol'
  ref: string
}

/** A research note as served by GET /admin/api/research/notes/:ticker (empty-but-200 when absent).
 *  Mirror of signal-service ResearchNote — `links` is server-derived from the body on PUT. */
export interface ResearchNote {
  ticker: string
  body: string
  links: ResearchLink[]
  updatedBy: string | null
  updatedAt: number | null
}

function fmtUpdated(updatedAt: number | null, updatedBy: string | null): string | null {
  if (updatedAt === null) return null
  const d = new Date(updatedAt)
  if (Number.isNaN(d.getTime())) return null
  const when = d.toISOString().replace('T', ' ').slice(0, 16) + 'Z'
  return updatedBy ? `Saved ${when} by ${updatedBy}` : `Saved ${when}`
}

export function ResearchNotes({
  ticker,
  initial,
  /** Tighter chrome for the drawer (smaller editor, no link summary) vs the full Overview panel. */
  compact = false,
}: {
  ticker: string
  initial: ResearchNote
  compact?: boolean
}) {
  const router = useRouter()
  // `saved` is the last server-confirmed note; `draft` is the in-flight edit. They diverge while the
  // operator types and re-converge on a successful save — so "unsaved changes" is `draft !== saved.body`.
  const [saved, setSaved] = useState<ResearchNote>(initial)
  const [draft, setDraft] = useState<string>(initial.body)
  const [view, setView] = useState<'write' | 'preview'>('write')
  const [busy, setBusy] = useState<false | 'save' | 'delete'>(false)
  const [error, setError] = useState<string | null>(null)

  // Re-seed when the symbol changes under us (the drawer reuses one mounted instance across symbols —
  // a stale draft from the previous symbol must not bleed across). Keyed on `initial.ticker` so a
  // re-render with the SAME note doesn't clobber an in-progress edit.
  const seededTicker = useRef(initial.ticker)
  useEffect(() => {
    if (seededTicker.current !== initial.ticker) {
      seededTicker.current = initial.ticker
      setSaved(initial)
      setDraft(initial.body)
      setView('write')
      setError(null)
    }
  }, [initial])

  const dirty = draft !== saved.body
  const hasSaved = saved.updatedAt !== null || saved.body.length > 0

  async function save() {
    if (busy) return
    // Confirm-before-overwrite ONLY when replacing an existing non-empty note — spell out the
    // consequence (per portal convention: terse "Are you sure?" is not enough). A first save of a
    // blank-then-typed note has nothing to clobber, so it goes straight through.
    if (hasSaved) {
      const ok = window.confirm(
        `Overwrite the saved research note for ${ticker}?\n\n` +
          'The previous version is replaced — the note store keeps only the latest body, so the ' +
          'current text is not recoverable after this save. Continue?',
      )
      if (!ok) return
    }
    setBusy('save')
    setError(null)
    try {
      const r = await fetch(`/portal-api/admin/research/notes/${encodeURIComponent(ticker)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: draft }),
      })
      const note = (await r.json().catch(() => null)) as ResearchNote | { error?: string } | null
      if (!r.ok || !note || !('body' in note)) {
        setError((note && 'error' in note && note.error) || `Save failed (${r.status})`)
        return
      }
      // Echo the authoritative server state (server-parsed links + stamped updatedAt) — no re-read.
      setSaved(note)
      setDraft(note.body)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (busy) return
    const ok = window.confirm(
      `Delete the research note for ${ticker}?\n\n` +
        'The note and its backlinks are removed permanently — any strategy/signal view that lists ' +
        'this note as a referrer will stop showing it. Continue?',
    )
    if (!ok) return
    setBusy('delete')
    setError(null)
    try {
      const r = await fetch(`/portal-api/admin/research/notes/${encodeURIComponent(ticker)}`, {
        method: 'DELETE',
      })
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `Delete failed (${r.status})`)
        return
      }
      const empty: ResearchNote = { ticker, body: '', links: [], updatedBy: null, updatedAt: null }
      setSaved(empty)
      setDraft('')
      setView('write')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  const updatedLine = fmtUpdated(saved.updatedAt, saved.updatedBy)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex overflow-hidden rounded border border-gray-700 text-xs">
          {(['write', 'preview'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-3 py-1 capitalize transition-colors ${
                view === v ? 'bg-gray-700 text-white' : 'bg-gray-900 text-gray-400 hover:text-gray-200'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        {dirty && <span className="text-[10px] uppercase tracking-wide text-amber-300">unsaved</span>}
      </div>

      {view === 'write' ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          placeholder={
            'Markdown supported. Link entities with @strategy:factor_rank_v1, @signal:<id>, ' +
            '@symbol:AAPL_US_EQ — they surface as backlinks on those views.'
          }
          className={`w-full resize-y rounded border border-gray-800 bg-gray-950 p-3 font-mono text-xs text-gray-200 placeholder:text-gray-600 focus:border-gray-600 focus:outline-none ${
            compact ? 'min-h-[8rem]' : 'min-h-[12rem]'
          }`}
        />
      ) : (
        <div
          className={`overflow-y-auto rounded border border-gray-800 bg-gray-950 p-3 ${
            compact ? 'max-h-[16rem]' : ''
          }`}
        >
          {draft.trim().length > 0 ? (
            <Markdown>{draft}</Markdown>
          ) : (
            <p className="text-sm text-gray-500">Nothing to preview yet.</p>
          )}
        </div>
      )}

      {/* Parsed @-links — only on the full panel (the drawer keeps a tight footprint). Shown from the
          SAVED links (server-parsed), so the operator sees exactly what the store indexed for backlinks. */}
      {!compact && saved.links.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-gray-500">Links</span>
          {saved.links.map((l) => (
            <span
              key={`${l.kind}:${l.ref}`}
              className="rounded bg-gray-800 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300"
            >
              @{l.kind}:{l.ref}
            </span>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!!busy || !dirty}
          className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-40"
        >
          {busy === 'save' ? 'Saving…' : 'Save note'}
        </button>
        {hasSaved && (
          <button
            type="button"
            onClick={remove}
            disabled={!!busy}
            className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:border-red-800 hover:text-red-300 disabled:opacity-40"
          >
            {busy === 'delete' ? 'Deleting…' : 'Delete'}
          </button>
        )}
        {updatedLine && <span className="text-[10px] text-gray-500">{updatedLine}</span>}
      </div>
    </div>
  )
}

export default ResearchNotes
