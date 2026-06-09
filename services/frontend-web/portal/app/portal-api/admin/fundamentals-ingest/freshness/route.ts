import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Per-name PIT-fundamentals freshness audit → fundamentals-ingestion
// /admin/api/fundamentals-ingest/freshness. Aggregate { universe, covered, missing, stale,
// coverage_pct, retirable, last_ingest_run } + per-name names[] { symbol, ticker, instrument_id,
// covered, newest_period_end, newest_knowledge_ts, last_stored_at, staleness_days, stale }. Drives
// the Operations summary (coverage C/U · stale · retirable) + the per-ticker table's ingest clock
// (last stored) and freshness columns. Degrades zeros/200 cold, 503 Timescale-down. Read-only.
export async function GET() {
  const r = await authedFetch('/admin/api/fundamentals-ingest/freshness')
  const body = await r.json().catch(() => null)
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
