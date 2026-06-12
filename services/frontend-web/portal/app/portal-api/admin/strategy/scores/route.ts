import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'
import { computeFreshness, type ExpectedLatestByMarket } from '@/app/lib/freshness'

// Factor-scores proxy → strategy-engine /admin/api/strategy/scores (the factor_scores reader).
// Forwards the optional ticker + asOf (point-in-time knowledge cutoff) query params:
//   (none)                → all-universe latest map { ticker: {observation_ts, factors} }
//   ?ticker=X             → that name's newest row
//   ?ticker=X&asOf=<ms>   → the as-of row (signal "Why?" reads as-of signal.timestamp)
// Browser → /portal-api/... → authedFetch through nginx → strategy-engine. JWT stays server-side.
// Upstream degrades a pre-backfill / unknown-ticker read to {}; this proxy passes that through
// (an empty object is a valid, non-error response — the Research surface renders "no scores yet").
//
// FRESHNESS ENRICHMENT: each row is stamped `stale` (boolean | null) by comparing its `observation_ts`
// against market-data /health's per-market `expected_latest_bar_ts` (the most recent completed
// session). The Research surfaces render an "as of <time> · Not live" tag off this, so a name the
// strategy couldn't refresh (markets closed / outage) shows the last-available data honestly tagged,
// not stale numbers presented as current. A live `asOf` read is deliberately NOT freshness-stamped
// (it's a historical point-in-time lookup, not "the latest"), so the tag never mislabels an audit read.

let healthCache: { ts: number; expected: ExpectedLatestByMarket } | null = null

async function expectedLatest(): Promise<ExpectedLatestByMarket> {
  const now = Date.now()
  if (healthCache && now - healthCache.ts < 30_000) return healthCache.expected
  try {
    const r = await authedFetch('/admin/api/market-data/health')
    const h = (await r.json().catch(() => ({}))) as { expected_latest_bar_ts?: ExpectedLatestByMarket }
    const expected = h?.expected_latest_bar_ts ?? {}
    healthCache = { ts: now, expected }
    return expected
  } catch {
    return healthCache?.expected ?? {}
  }
}

interface ScoreRow {
  ticker?: string
  observation_ts?: number
  factors?: Record<string, unknown>
  stale?: boolean | null
}

function isScoreRow(v: unknown): v is ScoreRow {
  return typeof v === 'object' && v !== null && 'factors' in (v as Record<string, unknown>)
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const ticker = searchParams.get('ticker') ?? ''
  const asOf = searchParams.get('asOf') ?? ''
  const qs = new URLSearchParams()
  if (ticker) qs.set('ticker', ticker)
  if (asOf) qs.set('asOf', asOf)
  const suffix = qs.toString()
  const r = await authedFetch(`/admin/api/strategy/scores${suffix ? `?${suffix}` : ''}`)
  const body = await r.json().catch(() => ({}))
  if (!r.ok) return NextResponse.json(body, { status: r.status })

  // Stamp freshness only on a "latest" read (no asOf) — an as-of read is a historical point-in-time
  // lookup, not "the latest", so tagging it "not live" would be wrong.
  if (!asOf && body && typeof body === 'object') {
    const expected = await expectedLatest()
    if (isScoreRow(body)) {
      // Single-ticker shape: { ticker, observation_ts, factors }.
      body.stale = computeFreshness(body.observation_ts, body.ticker ?? ticker, expected).stale
    } else {
      // All-universe map shape: { TICKER: { observation_ts, factors } }.
      for (const [t, row] of Object.entries(body as Record<string, unknown>)) {
        if (isScoreRow(row)) row.stale = computeFreshness(row.observation_ts, t, expected).stale
      }
    }
  }
  return NextResponse.json(body, { status: 200 })
}
