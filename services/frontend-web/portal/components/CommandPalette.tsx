'use client'
// Global ⌘K command palette (agent-docs/plans/portal-ia-redesign.md, then wired
// by epic-portal-post-redesign-fixes Task 1; entity search + frecency added by
// research-trading-os Task 21 — agent-docs/plans/research-trading-os.md §D).
//
// MOUNTING: a single <CommandPalette/> is mounted in app/(authed)/layout.tsx
// (inside NuqsAdapter + TooltipProvider + ModeProvider + DrawerProvider) so the
// hotkey is live across the authed tree AND useResearchDrawer() resolves. It is
// self-contained — there is nothing for the layout to pass in.
//
// HYDRATION: `open` starts false, so on the server (and the first client render)
// cmdk's Command.Dialog renders nothing — no portal, no markup mismatch. The
// hotkey only flips it open after mount.
//
// TWO LAYERS (mode-prefix):
//   • A leading '>' filters to COMMANDS only (the static registry — workspaces /
//     tabs / actions, locked by command-registry.test.ts + route-resolution.test.ts).
//   • Bare text DEBOUNCE-queries /portal-api/search (Task 20) and renders dynamic
//     Tickers / Strategies / Signals groups ABOVE the command groups. These entity
//     results are NOT in COMMANDS (they are server-driven) so the registry drift
//     tests stay unchanged.
// An empty query surfaces the frecency shortlist (recent entities) first.
//
// ROUTING a selected entity:
//   • ticker   → useResearchDrawer().open(symbol) — the in-context overlay (deep
//     links still use the full /research?symbol=… route, which the drawer mirrors).
//   • signal   → /signals/[id] (the real detail page, an email/bookmark target).
//   • strategy → /build?tab=strategy (the Build · Strategy view).
//
// shouldFilter={false}: cmdk's built-in fuzzy filter is disabled because we own
// matching on both sides — commands via the pure filterCommands(), entities via the
// server's relevance rank (Task 20) — so the two layers can't fight over one filter.
import * as RadixDialog from '@radix-ui/react-dialog'
import { Command } from 'cmdk'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { logout } from '@/app/actions/auth'
// setMode comes from the dedicated 'use server' module — NOT @/app/lib/mode, which
// carries `import 'server-only'` and would fail the build when pulled into this
// 'use client' component (AGENTS.md mode.ts gotcha).
import { setMode } from '@/app/lib/mode-actions'
import { COMMANDS, filterCommands, type Command as PaletteCommand } from '@/app/lib/command-registry'
import type { SearchResults } from '@/app/lib/search-merge'
import { loadRecents, rankRecents, recordRecent, type RecentEntity } from '@/app/lib/frecency'
import { useMode } from '@/components/ModeProvider'
import { useResearchDrawer } from '@/components/ResearchDrawer'

// Leading char that switches the palette into command-only mode.
const COMMAND_PREFIX = '>'
// Debounce before firing the entity search, so an as-you-type query is one request
// per pause, not one per keystroke. 200ms reads as instant while collapsing bursts.
const SEARCH_DEBOUNCE_MS = 200

// An empty grouped result — the resting shape before any query / on a failed fetch.
const EMPTY_RESULTS: SearchResults = { tickers: [], strategies: [], signals: [] }

export function CommandPalette() {
  const router = useRouter()
  const mode = useMode()
  const drawer = useResearchDrawer()
  const [open, setOpen] = useState(false)
  // Raw input value (includes a leading '>' in command mode). cmdk's filtering is
  // disabled, so we drive everything off this.
  const [query, setQuery] = useState('')
  // The latest search response, tagged with the query it answers. Rendering is gated
  // on `forQuery === entityQuery`, so a stale response (or a switch into command mode)
  // simply isn't shown — no need to synchronously clear it in an effect, which keeps
  // the effects setState-free in their synchronous bodies.
  const [results, setResults] = useState<{ forQuery: string; data: SearchResults }>({
    forQuery: '',
    data: EMPTY_RESULTS,
  })
  // Frecency shortlist, loaded from localStorage when the palette opens (client-only,
  // so it can't run during SSR). Surfaced first on an empty query.
  const [recents, setRecents] = useState<RecentEntity[]>([])

  // Open/close from the chord or any Radix dismiss (Escape / overlay click). Done as
  // an event handler — not an effect — so loading recents + resetting the query are
  // direct reactions to the toggle, with no setState-in-effect render cascade.
  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next)
    if (next) setRecents(loadRecents())
    else setQuery('')
  }, [])

  // ⌘K (Mac) / Ctrl+K (Win/Linux). preventDefault so the browser's own
  // ⌘K (focus address bar / search) doesn't also fire. enableOnFormTags:false
  // keeps the chord from hijacking keystrokes while a user is typing in an input
  // elsewhere in the app (the palette's own input is rendered inside the dialog,
  // which is unmounted while closed, so toggling-closed-from-inside still works).
  useHotkeys(
    'mod+k',
    (e) => {
      e.preventDefault()
      onOpenChange(!open)
    },
    { enableOnFormTags: false },
    [open, onOpenChange],
  )

  // Command mode iff the input starts with '>'. The remainder (sans prefix) is the
  // command filter; an empty remainder shows the whole registry.
  const isCommandMode = query.startsWith(COMMAND_PREFIX)
  const commandQuery = isCommandMode ? query.slice(COMMAND_PREFIX.length).trim() : query.trim()
  // Entity search runs only in bare-text mode (not '>') and only with a non-empty term.
  const entityQuery = isCommandMode ? '' : query.trim()

  // Debounced entity search. A fresh keystroke resets the timer; only the last term
  // in a burst fires. An in-flight result for a stale term is discarded (the cancel
  // flag) so out-of-order responses never clobber the current query's results, and
  // the stored result is tagged with its query so a stale tag never renders. No
  // request in command mode or for an empty term (those render commands / recents).
  useEffect(() => {
    if (!open || isCommandMode || entityQuery === '') return
    let cancelled = false
    const t = setTimeout(() => {
      void (async () => {
        try {
          const r = await fetch(`/portal-api/search?q=${encodeURIComponent(entityQuery)}`)
          if (!r.ok) {
            if (!cancelled) setResults({ forQuery: entityQuery, data: EMPTY_RESULTS })
            return
          }
          const body = (await r.json()) as SearchResults
          if (!cancelled) setResults({ forQuery: entityQuery, data: body })
        } catch {
          if (!cancelled) setResults({ forQuery: entityQuery, data: EMPTY_RESULTS })
        }
      })()
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [open, isCommandMode, entityQuery])

  // Only show the response that belongs to the current query (guards a stale tag /
  // a just-typed term whose fetch hasn't landed yet).
  const entities = !isCommandMode && results.forQuery === entityQuery ? results.data : EMPTY_RESULTS

  // The visible command list: filtered by the (prefix-stripped) command query.
  const commandGroups = useMemo(() => {
    const matched = filterCommands(commandQuery, COMMANDS)
    const byGroup = new Map<string, PaletteCommand[]>()
    for (const cmd of matched) {
      const list = byGroup.get(cmd.group)
      if (list) list.push(cmd)
      else byGroup.set(cmd.group, [cmd])
    }
    return [...byGroup.entries()]
  }, [commandQuery])

  // Frecency shortlist for the empty-query view, ranked client-side at render time
  // (recency decays continuously, so we score against "now" rather than a stale order).
  const rankedRecents = useMemo(() => rankRecents(recents), [recents])
  // Show recents only on a truly empty palette (no '>' prefix, no term).
  const showRecents = !isCommandMode && entityQuery === '' && rankedRecents.length > 0

  // Route an entity selection, recording it into frecency first so the shortlist
  // reflects the just-used name on the next open. Closes the palette either way.
  const openTicker = useCallback(
    (t: { symbol: string; name: string; sector: string }) => {
      setOpen(false)
      setRecents(recordRecent({ kind: 'ticker', id: t.symbol, label: t.symbol, sublabel: t.name || t.sector }))
      // The in-context overlay is the primary affordance; the full /research?symbol=
      // route is the deep-link equivalent the drawer mirrors.
      drawer.open(t.symbol)
    },
    [drawer],
  )

  const openSignal = useCallback(
    (s: { id: string; ticker: string; action: string }) => {
      setOpen(false)
      setRecents(
        recordRecent({ kind: 'signal', id: s.id, label: `${s.ticker} ${s.action}`.trim(), sublabel: s.id }),
      )
      router.push(`/signals/${s.id}`)
    },
    [router],
  )

  const openStrategy = useCallback(
    (st: { id: string }) => {
      setOpen(false)
      setRecents(recordRecent({ kind: 'strategy', id: st.id, label: st.id, sublabel: 'Strategy' }))
      // The Build · Strategy view owns the active-strategy selector + params.
      router.push('/build?tab=strategy')
    },
    [router],
  )

  // Re-open a frecency entry by replaying the same routing as a fresh hit (also
  // re-records it, keeping the shortlist fresh).
  const openRecent = useCallback(
    (e: RecentEntity) => {
      if (e.kind === 'ticker') openTicker({ symbol: e.id, name: e.label, sector: e.sublabel ?? '' })
      else if (e.kind === 'signal') openSignal({ id: e.id, ticker: e.label, action: '' })
      else openStrategy({ id: e.id })
    },
    [openTicker, openSignal, openStrategy],
  )

  const onSelectCommand = useCallback(
    (cmd: PaletteCommand) => {
      setOpen(false)
      // Navigation commands carry an href → jump to their route.
      if (cmd.href) {
        router.push(cmd.href)
        return
      }
      // Action commands carry no href and are dispatched by id. The registry +
      // command-registry.test.ts lock the action set to exactly
      // {act.toggle-mode, act.sign-out}, so this switch is exhaustive.
      switch (cmd.id) {
        case 'act.toggle-mode':
          // Mirror <ModeToggle/>: flip the display cookie, then router.refresh()
          // so server surfaces (getMode() + any <QuantOnly>) re-evaluate. Display
          // preference only — never a trading mutation, never gates safety controls.
          void setMode(mode === 'quant' ? 'beginner' : 'quant').then(() => router.refresh())
          break
        case 'act.sign-out':
          // Server action: deleteSession() + redirect('/login').
          void logout()
          break
      }
    },
    [router, mode],
  )

  const hasEntities =
    entities.tickers.length > 0 || entities.strategies.length > 0 || entities.signals.length > 0

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      loop
      shouldFilter={false}
      overlayClassName="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
      contentClassName="fixed left-1/2 top-[20%] z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border border-gray-800 bg-gray-900 text-gray-200 shadow-xl focus:outline-none"
    >
      {/* Screen-reader title/description for the underlying Radix dialog. cmdk
          renders these children inside its Dialog.Content and shares the single
          deduped @radix-ui/react-dialog instance, so they register with that
          dialog's context and satisfy its a11y requirement (otherwise Radix
          logs a missing-DialogTitle warning). Visually hidden — the visible
          affordance is the input below. */}
      <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
      <RadixDialog.Description className="sr-only">
        Search tickers, strategies, and signals, or type &gt; to filter commands.
      </RadixDialog.Description>
      <Command.Input
        value={query}
        onValueChange={setQuery}
        placeholder="Search tickers, strategies, signals… (› for commands)"
        className="w-full border-b border-gray-800 bg-transparent px-4 py-3 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto overflow-x-hidden p-2">
        <Command.Empty className="px-3 py-6 text-center text-sm text-gray-500">
          No results.
        </Command.Empty>

        {/* Frecency shortlist — recent entities first, only on an empty bare query. */}
        {showRecents && (
          <Command.Group
            heading="Recent"
            className="px-1 py-1 text-xs font-medium text-gray-500 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            {rankedRecents.map((e) => (
              <Command.Item
                key={`recent:${e.kind}:${e.id}`}
                value={`recent:${e.kind}:${e.id}`}
                onSelect={() => openRecent(e)}
                className="flex cursor-pointer items-center justify-between gap-2 rounded px-3 py-2 text-sm text-gray-300 aria-selected:bg-gray-800 aria-selected:text-white"
              >
                <span className="truncate">{e.label}</span>
                <span className="ml-2 shrink-0 text-xs uppercase text-gray-500">{e.kind}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {/* Entity results (Tickers / Strategies / Signals) — ABOVE the commands when
            a bare-text query matched anything. Server-ranked; not in COMMANDS. */}
        {!isCommandMode && hasEntities && (
          <>
            {entities.tickers.length > 0 && (
              <Command.Group
                heading="Tickers"
                className="px-1 py-1 text-xs font-medium text-gray-500 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
              >
                {entities.tickers.map((t) => (
                  <Command.Item
                    key={`ticker:${t.symbol}`}
                    value={`ticker:${t.symbol}`}
                    onSelect={() => openTicker(t)}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded px-3 py-2 text-sm text-gray-300 aria-selected:bg-gray-800 aria-selected:text-white"
                  >
                    <span className="truncate font-medium text-gray-200">{t.symbol}</span>
                    <span className="ml-2 truncate text-xs text-gray-500">
                      {[t.name, t.sector].filter(Boolean).join(' · ')}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {entities.strategies.length > 0 && (
              <Command.Group
                heading="Strategies"
                className="px-1 py-1 text-xs font-medium text-gray-500 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
              >
                {entities.strategies.map((s) => (
                  <Command.Item
                    key={`strategy:${s.id}`}
                    value={`strategy:${s.id}`}
                    onSelect={() => openStrategy(s)}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded px-3 py-2 text-sm text-gray-300 aria-selected:bg-gray-800 aria-selected:text-white"
                  >
                    <span className="truncate">{s.id}</span>
                    {s.active && (
                      <span className="ml-2 shrink-0 text-xs font-medium text-emerald-400">active</span>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {entities.signals.length > 0 && (
              <Command.Group
                heading="Signals"
                className="px-1 py-1 text-xs font-medium text-gray-500 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
              >
                {entities.signals.map((s) => (
                  <Command.Item
                    key={`signal:${s.id}`}
                    value={`signal:${s.id}`}
                    onSelect={() => openSignal(s)}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded px-3 py-2 text-sm text-gray-300 aria-selected:bg-gray-800 aria-selected:text-white"
                  >
                    <span className="truncate">
                      <span className="font-medium text-gray-200">{s.ticker}</span>
                      {s.action && <span className="ml-1 text-gray-400">{s.action}</span>}
                    </span>
                    <span className="ml-2 shrink-0 text-xs text-gray-500">{s.strategy_id}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </>
        )}

        {/* Command groups (workspaces / tabs / actions) — the static registry. In
            command mode ('>') these are the only thing shown. */}
        {commandGroups.map(([group, cmds]) => (
          <Command.Group
            key={group}
            heading={group}
            className="px-1 py-1 text-xs font-medium text-gray-500 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            {cmds.map((cmd) => (
              <Command.Item
                key={cmd.id}
                value={cmd.id}
                onSelect={() => onSelectCommand(cmd)}
                className="flex cursor-pointer items-center rounded px-3 py-2 text-sm text-gray-300 aria-selected:bg-gray-800 aria-selected:text-white"
              >
                {cmd.label}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  )
}
