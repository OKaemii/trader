'use client'
import { createContext, useContext } from 'react'
import type { Mode } from '@/app/lib/mode-parse'

// Client-side view of the Beginner⇄Quant mode. Seeded from the server-read cookie via the
// `initial` prop (the layout passes `await getMode()`), so the first client paint already
// matches the SSR markup — no flash. The toggle persists the cookie + router.refresh()es,
// which re-runs the server tree and re-seeds `initial`; we don't hold mutable state here.

const ModeContext = createContext<Mode | null>(null)

export function ModeProvider({
  initial,
  children,
}: {
  initial: Mode
  children: React.ReactNode
}) {
  return <ModeContext.Provider value={initial}>{children}</ModeContext.Provider>
}

/** Read the current mode. Throws if used outside a <ModeProvider> (a wiring bug). */
export function useMode(): Mode {
  const mode = useContext(ModeContext)
  if (mode === null) {
    throw new Error('useMode must be used within a <ModeProvider>')
  }
  return mode
}
