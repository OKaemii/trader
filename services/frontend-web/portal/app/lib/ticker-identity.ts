// Portal-local mirror of `@trader/ticker-identity` (packages/ticker-identity/src/adapter.ts). The
// portal is a standalone Next.js app OUTSIDE the pnpm workspace, so it cannot import the workspace
// package — this is the documented "local mirror" pattern (see the `Mirror of @trader/shared-types`
// notes elsewhere in the portal). Keep the suffix rule + the FB→META rename in lockstep with the
// upstream adapter; this is the ONLY place the portal knows the `_US_EQ` / `l_EQ` broker form.
//
// Why the portal needs it (epic pit-fundamentals-lake-rearchitecture, Task 21): the bare ticker
// `(symbol, market)` is the platform source of truth. The universe-overrides API still echoes the
// legacy T212 form on the wire (Task 16b/18 left that for Task 21 to remove), so the portal parses it
// to the bare identity for display + posts the bare `{symbol, market}` form back (the backend PUT has
// accepted `{symbol, market}` objects since Task 18). Rendering is bare `symbol`; the broker suffix
// never reaches the operator.

export type Market = 'US' | 'LSE'

export interface TickerIdentity {
  symbol: string
  market: Market
}

const US_SUFFIX = '_US_EQ'
const LSE_SUFFIX = 'l_EQ'

// Legacy-rename table — keyed by (market, fromSymbol) because a rebrand is listing-specific. Seeded
// from the upstream adapter's RENAMES (US Facebook → Meta). Kept narrow on purpose.
const RENAMES: Record<Market, Record<string, string>> = {
  US: { FB: 'META' },
  LSE: {},
}

/**
 * The broker's ticker string → bare identity, the strict inverse of {@link toT212}:
 * `'GOOGL_US_EQ' → { GOOGL, US }`, `'SHELl_EQ' → { SHEL, LSE }`.
 *
 * TOLERANT by design (unlike the upstream adapter, which throws): the portal renders whatever the
 * active universe contains, and a non-US/LSE form (an `OTHER` suffix, a CFD, a malformed value, or —
 * post-cutover — an already-bare symbol) must not crash a list render. A string that isn't a
 * recognised US/LSE equity form returns `null`; the caller falls back to showing the raw value.
 */
export function fromT212(t212: string | null | undefined): TickerIdentity | null {
  const raw = (t212 ?? '').trim()
  if (raw.endsWith(US_SUFFIX)) {
    const symbol = raw.slice(0, -US_SUFFIX.length)
    return symbol.length === 0 ? null : { symbol, market: 'US' }
  }
  if (raw.endsWith(LSE_SUFFIX)) {
    const symbol = raw.slice(0, -LSE_SUFFIX.length)
    return symbol.length === 0 ? null : { symbol, market: 'LSE' }
  }
  return null
}

/**
 * Bare identity → the broker's ticker string. `{ GOOGL, US } → 'GOOGL_US_EQ'`;
 * `{ SHEL, LSE } → 'SHELl_EQ'`. The portal only needs this where it must echo a legacy-shaped value
 * back to an endpoint that hasn't migrated; the universe PUT accepts the bare object directly, so
 * this is mostly here for symmetry + tests.
 */
export function toT212(id: TickerIdentity): string {
  const symbol = id.symbol.trim()
  if (symbol.length === 0) throw new Error('[ticker-identity] empty symbol')
  return id.market === 'US' ? `${symbol}${US_SUFFIX}` : `${symbol}${LSE_SUFFIX}`
}

/** Apply the market-aware legacy rename (US `FB → META`); returns the input unchanged when none applies. */
export function applyRename(id: TickerIdentity): TickerIdentity {
  const renamed = RENAMES[id.market][id.symbol.trim().toUpperCase()]
  if (renamed === undefined || renamed === id.symbol) return id
  return { symbol: renamed, market: id.market }
}

/**
 * Normalise a forced-add as the operator types it into the bare identity the UI stores + posts.
 * Accepts a bare `'GOOGL'` (market from the selector, default US), an already-bare-but-explicit
 * value, or a pasted legacy T212 string (`'AAPL_US_EQ'` / `'SGLNl_EQ'` — the market in the suffix
 * wins over the selector). Returns `null` on an empty symbol so the caller can ignore the entry.
 *
 * The bare symbol is upper-cased + the rename applied so the stored identity is canonical (META, not
 * FB) and matches the backend's own `resolveForcedAdd` normalisation. The market selector is the
 * fallback ONLY when the typed value carries no listing of its own.
 */
export function parseForcedAdd(raw: string, marketHint: Market): TickerIdentity | null {
  const s = raw.trim()
  if (s === '') return null
  // A pasted legacy T212 string carries its own listing — the suffix market wins over the selector.
  // Try the canonical-case string first (handles `SGLNl_EQ` whose lowercase `l` is load-bearing),
  // then an upper-cased retry to catch a lower-cased US form (`aapl_us_eq`).
  for (const candidate of s === s.toUpperCase() ? [s] : [s, s.toUpperCase()]) {
    const parsed = fromT212(candidate)
    if (parsed) return applyRename({ symbol: parsed.symbol.toUpperCase(), market: parsed.market })
  }
  // A bare symbol — use the selector's market.
  return applyRename({ symbol: s.toUpperCase(), market: marketHint })
}

/** Stable de-dup key for an identity (`SYMBOL|MARKET`). */
export function identityKey(id: TickerIdentity): string {
  return `${id.symbol.toUpperCase()}|${id.market}`
}
