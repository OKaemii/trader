// Per-exchange session-state badge. Reads the live state from market-data-service's
// /health endpoint via the gateway proxy and shows REGULAR/PRE/POST/CLOSED with a
// colour code matching the market gate's pollable distinction:
//
//   REGULAR  green   — fully open, pollable
//   PRE      yellow  — pre-market session, pollable (cache primed for open)
//   POST     yellow  — post-close grace, pollable for late EOD print
//   CLOSED   gray    — weekend / holiday / past grace, NOT polled

import type { Market } from './market'

export type MarketState = 'REGULAR' | 'PRE' | 'POST' | 'CLOSED'

const STATE_STYLES: Record<MarketState, { bg: string; text: string; label: string }> = {
  REGULAR: { bg: 'bg-emerald-900/50', text: 'text-emerald-300', label: 'OPEN' },
  PRE:     { bg: 'bg-amber-900/50',   text: 'text-amber-300',   label: 'PRE' },
  POST:    { bg: 'bg-amber-900/50',   text: 'text-amber-300',   label: 'POST' },
  CLOSED:  { bg: 'bg-gray-800',       text: 'text-gray-400',    label: 'CLOSED' },
}

interface Props {
  market: Market | 'US' | 'LSE'
  state:  MarketState
  className?: string
  // Optional "Mon 13:30 UTC" tooltip when CLOSED — pass the formatted next-open if you
  // have it, otherwise omit.
  nextOpen?: string | null
}

export function MarketStateBadge({ market, state, className = '', nextOpen }: Props) {
  const style = STATE_STYLES[state]
  const title = state === 'CLOSED' && nextOpen ? `Next ${market} open: ${nextOpen}` : `${market} ${style.label}`
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${style.bg} ${style.text} ${className}`}
      title={title}
    >
      <span className="text-[10px] opacity-70">{market}</span>
      <span>{style.label}</span>
    </span>
  )
}
