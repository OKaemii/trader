import 'server-only'
import { authedFetch } from '@/app/lib/auth-fetch'
import { computeFreshness, type ExpectedLatestByMarket, type Freshness } from '@/app/lib/freshness'

// Server-side freshness: reads market-data /health (the per-market expected-latest-bar + session
// states) and turns it into a `stale`/`asOf` verdict the Research/Discover server surfaces stamp onto
// the data they SSR-seed (the scores proxy does the same for the client-fetch path). 30s in-process
// cache; degrades to the last good value (or empties) on any failure so a freshness tag never blocks
// a render. `server-only`: this pulls authedFetch and must never enter the client bundle.

type SessionStates = Partial<Record<'US' | 'LSE', 'REGULAR' | 'PRE' | 'POST' | 'CLOSED'>>

export interface HealthFreshness {
  expected: ExpectedLatestByMarket
  sessionStates: SessionStates
}

let cache: { ts: number; v: HealthFreshness } | null = null

export async function getHealthFreshness(): Promise<HealthFreshness> {
  const now = Date.now()
  if (cache && now - cache.ts < 30_000) return cache.v
  try {
    const r = await authedFetch('/admin/api/market-data/health')
    const h = (await r.json().catch(() => ({}))) as {
      expected_latest_bar_ts?: ExpectedLatestByMarket
      session_states?: SessionStates
    }
    const v: HealthFreshness = {
      expected: h?.expected_latest_bar_ts ?? {},
      sessionStates: h?.session_states ?? {},
    }
    cache = { ts: now, v }
    return v
  } catch {
    return cache?.v ?? { expected: {}, sessionStates: {} }
  }
}

/** Freshness verdict for one datum (a factor row's observation_ts vs its market's last session). */
export async function freshnessFor(
  observationTs: number | null | undefined,
  ticker: string | null | undefined,
): Promise<Freshness> {
  const { expected } = await getHealthFreshness()
  return computeFreshness(observationTs, ticker, expected)
}

/** Market-level freshness for a price-derived surface (the scanner's caps are last-close × shares):
 *  "as of the last <market> session" + stale when that market is currently CLOSED. US-default (the
 *  scanner universe is US-heavy). `stale=null` when the session state is unknown. */
export async function marketFreshness(
  market: 'US' | 'LSE' = 'US',
): Promise<{ asOf: number | null; stale: boolean | null }> {
  const { expected, sessionStates } = await getHealthFreshness()
  const exp = expected[market]
  const asOf = typeof exp === 'number' && Number.isFinite(exp) ? exp : null
  const state = sessionStates[market]
  const stale = state ? state === 'CLOSED' : null
  return { asOf, stale }
}
