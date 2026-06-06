'use client'
import { useMode } from './ModeProvider'

// Gate for advanced/quant-only panels (MCPT/PBO/DSR internals, factor-decomposition/
// Betti/topology charts, bi-temporal as-of audit, optimiser-cap editors). Renders its
// children only in quant mode; beginner mode curates them away.
//
// IMPORTANT: never wrap operationally-critical surfaces in this — kill switch,
// circuit-breaker state, flatten/pause, live-order warnings, positions, and P&L must
// stay visible in BOTH modes (enforced by convention + the epic QA check).
export function QuantOnly({ children }: { children: React.ReactNode }) {
  const mode = useMode()
  if (mode !== 'quant') return null
  return <>{children}</>
}
