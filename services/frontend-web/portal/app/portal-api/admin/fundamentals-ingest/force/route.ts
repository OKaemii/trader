import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Force a PIT-fundamentals ingest run → fundamentals-ingestion /admin/api/fundamentals-ingest/force.
// Starts the Task-9 orchestrator in-cluster as a single-flight BACKGROUND task and returns its run_id
// immediately (never blocks on the multi-minute backfill). A concurrent trigger is a no-op accept
// (started=false) — the heavy backfill is never duplicated. Optional { tickers:[...] } scopes the run;
// omit ⇒ the full coverage set. Poll the returned run_id via …/runs/{run_id}.
export async function POST(req: Request) {
  const payload = await req.json().catch(() => ({}))
  const r = await authedFetch('/admin/api/fundamentals-ingest/force', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
