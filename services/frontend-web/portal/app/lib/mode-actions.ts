'use server'
import { cookies } from 'next/headers'
import type { Mode } from './mode-parse'

// The Beginner⇄Quant cookie *write*, isolated in a top-level `'use server'` module.
//
// Why its own file (not in mode.ts): mode.ts carries `import 'server-only'`, which
// throws if that module is pulled into the client browser graph. <ModeToggle/> (a
// client component) imports this server action, and once the toggle is mounted in the
// nav (Task 12), AppNav→ModeToggle is a client→client chain — so the action's module
// must be a clean "use server" module that the bundler can replace with an RPC stub on
// the client, never bundling a `server-only` side-effect. mode.ts re-exports `setMode`
// from here, so the public import surface `@/app/lib/mode` is unchanged.
const COOKIE_NAME = 'trader_mode'

/**
 * Persist the mode. Server action invoked from the client <ModeToggle/>.
 *
 * `httpOnly: false` is deliberate: the cookie carries no secret (only a display
 * preference) and the client toggle must read it to seed its initial switch state.
 * `sameSite: 'lax'`, 1-year maxAge, path '/' so it applies across the whole portal.
 */
export async function setMode(mode: Mode): Promise<void> {
  ;(await cookies()).set(COOKIE_NAME, mode, {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  })
}
