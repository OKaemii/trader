import 'server-only'
import { cookies } from 'next/headers'
import { parseMode, type Mode } from './mode-parse'

// Beginner⇄Quant complexity mode, cookie-backed for no-flash SSR (read server-side in
// the layout; à la Coinbase Simple/Advanced). Default is **quant** — beginner is opt-in,
// we never hide surfaces from the current operator. Safety controls (kill switch,
// circuit-breaker state, live-order warnings) stay visible in BOTH modes; only
// <QuantOnly>-wrapped advanced panels are curated away in beginner.
//
// Re-export the pure seam so callers have a single import surface (`@/app/lib/mode`).
// `parseMode` itself lives in ./mode-parse (no `server-only`) so vitest can test it.
// `setMode` lives in ./mode-actions (a top-level `'use server'` module) so the client
// <ModeToggle/> can import the action without dragging this `server-only` module into
// the browser graph; re-exported here so `@/app/lib/mode` stays a single import surface.
export { parseMode, type Mode }
export { setMode } from './mode-actions'

const COOKIE_NAME = 'trader_mode'

/** Server-side read of the persisted mode from the `trader_mode` cookie (default quant). */
export async function getMode(): Promise<Mode> {
  return parseMode((await cookies()).get(COOKIE_NAME)?.value)
}
