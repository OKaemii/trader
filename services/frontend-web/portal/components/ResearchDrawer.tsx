'use client'
// The universal research drawer: a single right-anchored slide-over mounted once in
// (authed)/layout.tsx, opened from anywhere via the useResearchDrawer() hook. Any
// symbol reference (a signal row, a position, a universe entry, a ⌘K entity hit)
// calls open(symbol) to surface the in-context overlay; deep links still navigate to
// the full /research?symbol=… route.
//
// State lives here (not in the URL) so opening the drawer never pushes a history
// entry — it's an overlay, not a navigation. The body is a placeholder for now;
// Task 35 fills it with the shared symbol panels (header, chart, factor bars, active
// signals, strategy exposure, notes, recent events).
//
// Client-only by construction: this file and ui/Drawer.tsx must NOT import any
// `server-only` module (e.g. app/lib/mode.ts) — doing so fails the Next build.
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/Drawer'

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
            <DrawerTitle>{symbol}</DrawerTitle>
            {/* Placeholder — Task 35 renders the shared symbol panels here. */}
            <p className="mt-4 text-sm text-gray-400">
              Research panels for {symbol} load here.
            </p>
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
