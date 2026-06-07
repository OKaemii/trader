import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'
import {
  buildSearchResults,
  type SearchResults,
  type UniverseBody,
  type StrategyListBody,
  type SignalsHistoryBody,
} from '@/app/lib/search-merge'

// Portal-side entity-search aggregator (Research/Trading OS Task 20). Fans authedFetch
// to three EXISTING admin list endpoints and returns one grouped, ranked result the ⌘K
// palette (T21) and the SymbolPicker (T23) consume verbatim:
//   { tickers: [...], strategies: [...], signals: [...] }
//
// This is deliberately a portal-side aggregator over already-mounted admin routes — it
// adds NO new backend endpoint, so it sidesteps the cross-service /internal 403 trap.
// Each authedFetch is authed by the user's JWT (parseAdminHeaders on the owning service);
// a single upstream failure degrades only its own group to [] (see fetchJson → null), it
// never 500s the whole route.

// How many recent signals to scan. The picker only needs the freshest names; 50 keeps the
// upstream cheap while still covering the last few cycles.
const SIGNALS_LIMIT = 50

// 15s shared cache. All three upstreams are admin-global list state (active universe,
// strategy list, recent signals) — not per-user — so a module-level cache keyed by the
// normalised query is safe and matches the 15s cadence the rest of the portal polls at.
const CACHE_TTL_MS = 15_000
// Hard size cap. An as-you-type box (T21 ⌘K) sends a fresh key per keystroke
// ("a","aa","aap"…), so without a bound the Map grows forever in the long-lived server
// process. cacheSet() prunes expired entries and evicts oldest-first past this cap.
const CACHE_MAX = 200
const cache = new Map<string, { at: number; body: SearchResults }>()

// Write a result while keeping the Map bounded: drop expired entries, then evict
// oldest-insertion keys until at/under CACHE_MAX (Map iterates in insertion order).
function cacheSet(key: string, body: SearchResults): void {
  const now = Date.now()
  for (const [k, v] of cache) {
    if (now - v.at >= CACHE_TTL_MS) cache.delete(k)
  }
  cache.set(key, { at: now, body })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const r = await authedFetch(path)
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  const query = (searchParams.get('q') ?? '').trim()
  const key = query.toLowerCase()

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json(hit.body)
  }

  // Fan the three reads in parallel. fetchJson resolves null (not throw) on any failure,
  // so Promise.all never rejects — one dead upstream → that group is [], the others stand.
  const [universe, strategies, signals] = await Promise.all([
    fetchJson<UniverseBody>('/admin/api/market-data/universe/overrides'),
    fetchJson<StrategyListBody>('/admin/api/strategy/list'),
    fetchJson<SignalsHistoryBody>(`/admin/api/signals/history?limit=${SIGNALS_LIMIT}`),
  ])

  // If every upstream failed the user is almost certainly unauthenticated (authedFetch
  // returns a 401 Response, which fetchJson maps to null for all three) — surface 401 so
  // the client can react, rather than an all-empty 200 that reads as "no matches".
  if (universe === null && strategies === null && signals === null) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = buildSearchResults(query, universe, strategies, signals)
  cacheSet(key, body)
  return NextResponse.json(body)
}
