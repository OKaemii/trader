import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Per-name PIT-fundamentals freshness audit → fundamentals-HARVESTER
// /admin/api/fundamentals-ingest/freshness. Aggregate { universe, covered, missing, stale,
// coverage_pct, retirable, no_edgar_count, no_edgar[] } + per-name names[] { symbol, cik, covered,
// newest_period_end, newest_knowledge_ts, last_filed, filing_cadence, staleness_days, stale }. Drives
// the Operations summary (coverage C/U · stale · retirable) + the per-name table's lake columns.
//
// The harvester has NO Mongo, so the universe is an INPUT: the portal forwards the active universe via
// ?symbols=BARE,SYMBOLS. Absent, the harvester defaults to the lake's currently-listed tickers. Cold
// lake ⇒ zeros/200. Read-only.
export async function GET(req: Request) {
  const symbols = new URL(req.url).searchParams.get('symbols')
  const qs = symbols ? `?symbols=${encodeURIComponent(symbols)}` : ''
  const r = await authedFetch(`/admin/api/fundamentals-ingest/freshness${qs}`)
  const body = await r.json().catch(() => null)
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
