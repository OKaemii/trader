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
export { parseMode, type Mode }

const COOKIE_NAME = 'trader_mode'

/** Server-side read of the persisted mode from the `trader_mode` cookie (default quant). */
export async function getMode(): Promise<Mode> {
  return parseMode((await cookies()).get(COOKIE_NAME)?.value)
}

/**
 * Persist the mode. Server action invoked from the client <ModeToggle/>.
 *
 * `httpOnly: false` is deliberate: the cookie carries no secret (only a display
 * preference) and the client toggle must read it to seed its initial switch state.
 * `sameSite: 'lax'`, 1-year maxAge, path '/' so it applies across the whole portal.
 */
export async function setMode(mode: Mode): Promise<void> {
  'use server'
  ;(await cookies()).set(COOKIE_NAME, mode, {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  })
}
