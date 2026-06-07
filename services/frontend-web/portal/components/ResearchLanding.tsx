'use client'
// Research landing — the no-`?symbol=` entry state of the symbol workspace
// (research-trading-os Task 23 — plan §E). Leads with a prominent SymbolPicker, then two
// quick-pick rails: Recent (the operator's own frecency shortlist, browser-local) and Popular
// (the top of the active universe, server-seeded). Picking from either rail navigates to that
// symbol's workspace via the same /research?symbol=…&tab=overview deep link the picker pushes.
//
// Client component because Recent reads localStorage (the shared ⌘K frecency store from Task
// 21) — there is no server-side per-user recents state. Popular is seeded by the server page
// (it owns the authedFetch) and passed in, so this island does no data fetching of its own
// beyond the picker's own search.
import Link from 'next/link'
import { useSyncExternalStore } from 'react'
import { SymbolPicker, symbolHref } from '@/components/SymbolPicker'
import { RECENTS_KEY, loadRecents, rankRecents, type RecentEntity } from '@/app/lib/frecency'

/** One popular-symbol chip, seeded from the active universe. */
export interface PopularSymbol {
  symbol: string
  name: string
  sector: string
}

// Frecency is a browser-local store (localStorage), so it can't be read during SSR. We read it
// via useSyncExternalStore — the React-blessed way to surface a client-only external value with
// a server snapshot — rather than a setState-in-effect (which the React lint rule flags). The
// snapshot is memoised on the raw localStorage string so getSnapshot returns a stable reference
// between renders (a fresh array each call would loop). The empty server snapshot keeps SSR and
// the first client paint identical (no recents until hydration), matching the no-flash contract.
const EMPTY_RECENTS: RecentEntity[] = []
let cachedRaw: string | null = null
let cachedSnapshot: RecentEntity[] = EMPTY_RECENTS

function subscribeRecents(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('storage', onChange)
  return () => window.removeEventListener('storage', onChange)
}

function getRecentsSnapshot(): RecentEntity[] {
  if (typeof window === 'undefined') return EMPTY_RECENTS
  const raw = window.localStorage.getItem(RECENTS_KEY)
  if (raw === cachedRaw) return cachedSnapshot
  cachedRaw = raw
  cachedSnapshot = rankRecents(loadRecents().filter((e) => e.kind === 'ticker'))
  return cachedSnapshot
}

export function ResearchLanding({ popular }: { popular: PopularSymbol[] }) {
  // Ticker-only frecency shortlist: the landing navigates to symbol workspaces, not
  // strategies/signals. Ranked so recency decays against "now" (done in the snapshot).
  const recents = useSyncExternalStore(subscribeRecents, getRecentsSnapshot, () => EMPTY_RECENTS)

  return (
    <div className="mx-auto max-w-2xl space-y-8 pt-4">
      <div className="space-y-2">
        <h2 className="text-lg font-medium text-gray-200">Research a symbol</h2>
        <p className="text-sm text-gray-400">
          Search any tracked ticker to open its workspace — overview, signals, strategy impact,
          fundamentals, and history.
        </p>
        <SymbolPicker autoFocus />
      </div>

      {recents.length > 0 && (
        <Rail title="Recent">
          {recents.map((e) => (
            <SymbolChip key={e.id} symbol={e.id} sub={e.sublabel ?? ''} />
          ))}
        </Rail>
      )}

      {popular.length > 0 && (
        <Rail title="Popular">
          {popular.map((p) => (
            <SymbolChip key={p.symbol} symbol={p.symbol} sub={p.name || p.sector} />
          ))}
        </Rail>
      )}
    </div>
  )
}

function Rail({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500">{title}</h3>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

function SymbolChip({ symbol, sub }: { symbol: string; sub: string }) {
  return (
    <Link
      href={symbolHref(symbol)}
      className="group flex max-w-[14rem] items-center gap-2 rounded border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm hover:border-gray-700 hover:bg-gray-800"
    >
      <span className="font-mono font-medium text-gray-200 group-hover:text-white">{symbol}</span>
      {sub && <span className="truncate text-xs text-gray-500">{sub}</span>}
    </Link>
  )
}
