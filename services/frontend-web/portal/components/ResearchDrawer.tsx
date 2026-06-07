'use client'
// The universal research drawer: a single right-anchored slide-over mounted once in
// (authed)/layout.tsx, opened from anywhere via the useResearchDrawer() hook. Any
// symbol reference (a signal row, a position, a universe entry, a ⌘K entity hit)
// calls open(symbol) to surface the in-context overlay; deep links still navigate to
// the full /research?symbol=… route.
//
// State lives here (not in the URL) so opening the drawer never pushes a history
// entry — it's an overlay, not a navigation. The body (Task 35) is <DrawerBody>: the
// shared, condensed symbol panels (header, chart, factor bars, active signals + Why?,
// strategy exposure, notes, recent events) — the SAME components the full
// /research?symbol= route uses, client-fetched on open.
//
// Client-only by construction: this file and ui/Drawer.tsx must NOT import any
// `server-only` module (e.g. app/lib/mode.ts) — doing so fails the Next build.
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/Drawer'
import { DrawerBody } from '@/components/DrawerBody'

type ResearchDrawerContextValue = {
  /** The symbol the drawer is currently showing, or null when closed. */
  symbol: string | null
  /** Whether the drawer is open. */
  isOpen: boolean
  /** Open the drawer on a symbol (e.g. 'AAPL'). Replaces any open symbol. */
  open: (symbol: string) => void
  /** Close the drawer. */
  close: () => void
}

const ResearchDrawerContext = createContext<ResearchDrawerContextValue | null>(null)

export function DrawerProvider({ children }: { children: React.ReactNode }) {
  const [symbol, setSymbol] = useState<string | null>(null)

  const open = useCallback((next: string) => setSymbol(next), [])
  const close = useCallback(() => setSymbol(null), [])

  // Radix drives open/close from `open` + `onOpenChange`; route Escape / overlay-click
  // / close-button (all surface as onOpenChange(false)) back through close() so the
  // hook's view of state stays the single source of truth.
  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next) setSymbol(null)
    },
    [],
  )

  const value = useMemo<ResearchDrawerContextValue>(
    () => ({ symbol, isOpen: symbol !== null, open, close }),
    [symbol, open, close],
  )

  return (
    <ResearchDrawerContext.Provider value={value}>
      {children}
      <Drawer open={symbol !== null} onOpenChange={onOpenChange}>
        {symbol !== null && (
          <DrawerContent aria-describedby={undefined}>
            <DrawerTitle>
              <span className="font-mono">{symbol}</span>
            </DrawerTitle>
            {/* The shared, condensed symbol panels — chart, factor bars, active signals + Why?,
                strategy exposure, notes (Task 34's slot, relocated in), recent events. Client-fetched
                on open with a per-symbol in-memory cache. key={symbol} so a symbol switch remounts the
                whole body (fresh load + the keyed FactorBars/DrawerNotes re-fetch). */}
            <DrawerBody key={symbol} symbol={symbol} />
          </DrawerContent>
        )}
      </Drawer>
    </ResearchDrawerContext.Provider>
  )
}

/**
 * Open/close the universal research drawer. Throws if used outside a
 * <DrawerProvider> (a wiring bug). Contract: { symbol, isOpen, open(symbol), close }.
 */
export function useResearchDrawer(): ResearchDrawerContextValue {
  const ctx = useContext(ResearchDrawerContext)
  if (ctx === null) {
    throw new Error('useResearchDrawer must be used within a <DrawerProvider>')
  }
  return ctx
}
