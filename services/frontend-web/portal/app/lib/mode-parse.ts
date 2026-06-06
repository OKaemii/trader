// Pure cookie-value → Mode parsing — the testable seam for the Beginner⇄Quant mode.
//
// Kept in its own module (no `import 'server-only'`) so vitest (node env) can exercise
// it directly: `server-only` is supplied by the Next build, not a resolvable node
// package, so importing `mode.ts` from a test throws "Cannot find package 'server-only'".
// `mode.ts` re-exports `Mode` + `parseMode` from here, so this is the one source of truth.

export type Mode = 'beginner' | 'quant'

/**
 * Map a raw `trader_mode` cookie value to a Mode.
 *
 * Default is **quant**: only the exact string `'beginner'` opts a user down to the
 * curated view. Anything else — missing cookie (`undefined`), empty string, an
 * unknown/legacy value, or a tampered value — falls back to `'quant'` so we never
 * hide surfaces from the operator on a malformed cookie.
 */
export function parseMode(value: string | undefined | null): Mode {
  return value === 'beginner' ? 'beginner' : 'quant'
}
