'use client'
// Ticker autocomplete for the Research workspace (research-trading-os Task 23 — plan §E).
//
// An inline, always-visible cmdk combobox (NOT the modal ⌘K palette) that the Research
// landing leads with: the operator types a few characters, the picker debounce-queries the
// Task 20 aggregator (/portal-api/search) and renders its Tickers group; selecting one
// navigates to that symbol's workspace (/research?symbol=<symbol>&tab=overview).
//
// It consumes the SearchResults shape (app/lib/search-merge.ts) verbatim — same contract the
// ⌘K palette uses — and reads only the `tickers` group (strategies/signals are out of scope
// for a symbol picker). cmdk's own fuzzy filter is disabled (shouldFilter={false}) because the
// server already relevance-ranks; the list mirrors what the server returned.
//
// Client-only: it owns input state + a debounced fetch + router.push, so it must be a
// 'use client' island. The deep link it pushes (/research?symbol=…&tab=overview) is the same
// route the workspace shell resolves, so a picked symbol and a pasted URL land identically.
import { Command } from 'cmdk'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { SearchResults, TickerResult } from '@/app/lib/search-merge'

// Debounce before firing the search so an as-you-type query is one request per pause, not one
// per keystroke. Matches the ⌘K palette's cadence (200ms reads as instant while collapsing bursts).
const SEARCH_DEBOUNCE_MS = 200

/** Build the symbol-workspace deep link for a picked ticker (Overview is the entry tab). */
export function symbolHref(symbol: string): string {
  return `/research?symbol=${encodeURIComponent(symbol)}&tab=overview`
}

export function SymbolPicker({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  // The latest ticker results tagged with the query they answer, so a stale in-flight
  // response (or a cleared input) never renders against the current term.
  const [results, setResults] = useState<{ forQuery: string; tickers: TickerResult[] }>({
    forQuery: '',
    tickers: [],
  })

  const term = query.trim()

  // Debounced search. A fresh keystroke resets the timer; only the last term in a burst fires.
  // An in-flight result for a stale term is discarded (the cancel flag) so out-of-order
  // responses never clobber the current query, and the stored result is tagged with its query.
  // An empty term fires nothing — the rendered list is gated on `forQuery === term` AND on a
  // non-empty term below, so a stale result is simply never shown rather than synchronously
  // cleared here (avoids a setState in the effect body).
  useEffect(() => {
    if (term === '') return
    let cancelled = false
    const t = setTimeout(() => {
      void (async () => {
        try {
          const r = await fetch(`/portal-api/search?q=${encodeURIComponent(term)}`)
          if (!r.ok) {
            if (!cancelled) setResults({ forQuery: term, tickers: [] })
            return
          }
          const body = (await r.json()) as SearchResults
          if (!cancelled) setResults({ forQuery: term, tickers: body.tickers ?? [] })
        } catch {
          if (!cancelled) setResults({ forQuery: term, tickers: [] })
        }
      })()
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [term])

  // Only show the response that belongs to the current query (guards a stale tag / a
  // just-typed term whose fetch hasn't landed yet).
  const tickers = results.forQuery === term ? results.tickers : []

  function pick(symbol: string) {
    router.push(symbolHref(symbol))
  }

  return (
    <Command
      label="Symbol search"
      shouldFilter={false}
      className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900"
    >
      <Command.Input
        value={query}
        onValueChange={setQuery}
        autoFocus={autoFocus}
        placeholder="Search a ticker… (e.g. AAPL)"
        className="w-full bg-transparent px-4 py-3 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none"
      />
      {term !== '' && (
        <Command.List className="max-h-72 overflow-y-auto overflow-x-hidden border-t border-gray-800 p-2">
          <Command.Empty className="px-3 py-6 text-center text-sm text-gray-500">
            No matching tickers.
          </Command.Empty>
          {tickers.map((t) => (
            <Command.Item
              key={t.symbol}
              value={t.symbol}
              onSelect={() => pick(t.symbol)}
              className="flex cursor-pointer items-center justify-between gap-2 rounded px-3 py-2 text-sm text-gray-300 aria-selected:bg-gray-800 aria-selected:text-white"
            >
              <span className="truncate font-medium text-gray-200">{t.symbol}</span>
              <span className="ml-2 truncate text-xs text-gray-500">
                {[t.name, t.sector].filter(Boolean).join(' · ')}
              </span>
            </Command.Item>
          ))}
        </Command.List>
      )}
    </Command>
  )
}
