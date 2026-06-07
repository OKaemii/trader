// Frecency for the ⌘K entity search (research-trading-os Task 21 — plan §D).
//
// "Frecency" = frequency × recency: the entities the operator reaches for most,
// most recently, surface first on an *empty* query so ⌘K opens onto a useful
// shortlist instead of a blank pane. Kept deliberately small + local: a capped
// list in the browser's localStorage, ranked by a single score that decays with
// age and grows with hit-count. No server round-trip, no per-user backend state.
//
// This module is split pure-core (rankRecents / touchRecents / parseRecents) +
// thin localStorage shell (loadRecents / recordRecent) so the ranking + dedupe
// contract is unit-testable in plain vitest, mirroring the search-merge /
// command-registry split (pure logic here, the I/O at the edge).

/** The three searchable entity kinds — matches the SearchResults groups from Task 20. */
export type RecentEntityKind = 'ticker' | 'strategy' | 'signal'

/**
 * One remembered selection. `id` is the stable identity within a kind (a ticker
 * symbol, a strategy id, a signal id) and, with `kind`, the dedupe key. `label` /
 * `sublabel` are the rendered text captured at selection time so an empty-query
 * render needs no re-fetch. `count` is the lifetime hit-count; `lastTs` the last
 * selection time (ms epoch) — together they drive the frecency score.
 */
export interface RecentEntity {
  kind: RecentEntityKind
  id: string
  label: string
  sublabel?: string
  count: number
  lastTs: number
}

// Cap the stored list so an always-on palette can't grow localStorage without
// bound; well past what an empty-query shortlist surfaces, so eviction only ever
// drops the coldest entries.
export const RECENTS_MAX = 50
// How many recents the empty-query view surfaces. A short, scannable shortlist.
export const RECENTS_SHOWN = 8
// localStorage key. Namespaced so it never collides with other portal prefs.
export const RECENTS_KEY = 'trader.cmdk.recents'

// Recency half-life: a hit's recency weight halves every ~3 days, so a name used
// often-but-long-ago eventually yields to a fresh interest without vanishing on
// the first idle day. Tunable; the unit only matters relative to `lastTs`.
const HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Frecency score for one entity at the given `now`. Higher sorts first. The score
 * is `count` weighted by an exponential recency decay, so frequency and recency
 * both pull: a many-times entity stays high for a while, a just-touched one jumps.
 */
export function frecencyScore(e: Pick<RecentEntity, 'count' | 'lastTs'>, now: number): number {
  const ageMs = Math.max(0, now - e.lastTs)
  const recency = Math.pow(0.5, ageMs / HALF_LIFE_MS)
  // +1 keeps a never-decayed single hit above a heavily-decayed older one, and
  // avoids a zero score collapsing the ordering when ages are large.
  return (e.count + 1) * recency
}

/**
 * Rank a recents list by frecency (highest first), most-frecent first. Pure: does
 * not mutate the input. `limit` truncates to the shortlist length.
 */
export function rankRecents(
  recents: RecentEntity[],
  now: number = Date.now(),
  limit: number = RECENTS_SHOWN,
): RecentEntity[] {
  return [...recents]
    .map((e) => ({ e, s: frecencyScore(e, now) }))
    .sort((a, b) => b.s - a.s || b.e.lastTs - a.e.lastTs)
    .slice(0, limit)
    .map((x) => x.e)
}

/**
 * Record a selection into a recents list and return the new list (pure — does not
 * mutate `recents`). An existing (kind,id) entry has its `count` bumped, `lastTs`
 * refreshed, and label/sublabel updated to the latest rendered text; a new entry is
 * inserted with count 1. The result is trimmed to the most-frecent entries past
 * RECENTS_MAX so the store stays bounded.
 */
export function touchRecents(
  recents: RecentEntity[],
  hit: { kind: RecentEntityKind; id: string; label: string; sublabel?: string },
  now: number = Date.now(),
): RecentEntity[] {
  const idx = recents.findIndex((e) => e.kind === hit.kind && e.id === hit.id)
  const next = [...recents]
  if (idx >= 0) {
    const prev = next[idx]
    next[idx] = {
      ...prev,
      label: hit.label,
      sublabel: hit.sublabel,
      count: prev.count + 1,
      lastTs: now,
    }
  } else {
    next.push({ kind: hit.kind, id: hit.id, label: hit.label, sublabel: hit.sublabel, count: 1, lastTs: now })
  }
  // Keep the most-frecent RECENTS_MAX; drop the coldest tail.
  if (next.length <= RECENTS_MAX) return next
  return rankRecents(next, now, RECENTS_MAX)
}

/**
 * Parse a raw localStorage string into a validated recents list. Tolerant by
 * design: any malformed/partial blob yields [] (a corrupt store must never throw
 * into the palette render). Drops entries missing the required identity fields.
 */
export function parseRecents(raw: string | null): RecentEntity[] {
  if (!raw) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const out: RecentEntity[] = []
  for (const item of data) {
    if (item === null || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (o.kind !== 'ticker' && o.kind !== 'strategy' && o.kind !== 'signal') continue
    if (typeof o.id !== 'string' || o.id.length === 0) continue
    if (typeof o.label !== 'string') continue
    out.push({
      kind: o.kind,
      id: o.id,
      label: o.label,
      sublabel: typeof o.sublabel === 'string' ? o.sublabel : undefined,
      count: typeof o.count === 'number' && o.count > 0 ? o.count : 1,
      lastTs: typeof o.lastTs === 'number' ? o.lastTs : 0,
    })
  }
  return out
}

// ── localStorage shell (browser-only; SSR-safe no-ops) ──────────────────────────

/** Read + parse the recents list. Returns [] on the server or any read failure. */
export function loadRecents(): RecentEntity[] {
  if (typeof window === 'undefined') return []
  try {
    return parseRecents(window.localStorage.getItem(RECENTS_KEY))
  } catch {
    return []
  }
}

/**
 * Record a selection and persist. Returns the new list (also for the caller to
 * update in-memory state without a re-read). No-op write on the server / on any
 * storage failure (quota, disabled storage) — frecency is best-effort, never a
 * hard dependency of the palette.
 */
export function recordRecent(hit: {
  kind: RecentEntityKind
  id: string
  label: string
  sublabel?: string
}): RecentEntity[] {
  const next = touchRecents(loadRecents(), hit)
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
    } catch {
      // ignore — storage may be full or disabled; the in-memory list still updates.
    }
  }
  return next
}
