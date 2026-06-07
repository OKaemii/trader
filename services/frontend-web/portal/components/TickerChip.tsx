'use client'

import { useResearchDrawer } from '@/components/ResearchDrawer'

// The universal cross-link affordance (research-trading-os Task 36, plan §G): any ticker
// reference anywhere in the portal becomes a drawer trigger. Clicking it surfaces the
// in-context research drawer (chart / factors / signals / notes / events) as an overlay —
// React state via useResearchDrawer().open(symbol), NO navigation / history push (the full
// /research?symbol= route stays the deep-link equivalent the drawer mirrors).
//
// Reusable so every surface (signal feed, holdings, positions, universe rows, scanner
// constituents) wires the same way and reads identically. It renders a bare <button> with
// the symbol text + whatever className the host already used on its <span>, so dropping it
// in keeps each surface's existing look (font-mono / colour / weight) while adding the
// open-on-click behaviour. Must be a client component (useResearchDrawer is a client hook),
// mounted under the <DrawerProvider> in (authed)/layout.tsx — every authed surface is.
//
// `children` lets a caller decorate the label (e.g. a market badge beside the symbol);
// when absent the symbol itself is the label. The visible chip text always reflects the
// `symbol`, while `open(symbol)` carries the canonical id (e.g. 'AAPL_US_EQ').
export function TickerChip({
  symbol,
  className = '',
  children,
  title,
}: {
  symbol: string
  className?: string
  children?: React.ReactNode
  title?: string
}) {
  const { open } = useResearchDrawer()
  return (
    <button
      type="button"
      onClick={() => open(symbol)}
      title={title ?? `Open ${symbol} research`}
      // Inherit the host's text styling; add only the affordance cues (pointer + hover
      // underline) so it reads as clickable without disturbing the surrounding layout.
      className={`cursor-pointer rounded hover:underline focus:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400 ${className}`}
    >
      {children ?? symbol}
    </button>
  )
}
