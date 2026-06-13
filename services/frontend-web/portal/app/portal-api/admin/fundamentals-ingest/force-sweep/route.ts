import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Force a harvester sweep → fundamentals-HARVESTER /admin/api/fundamentals-ingest/force-sweep. Triggers
// an immediate single-flight EDGAR→lake sweep in-cluster (refreshes recently-filed CIKs). Returns
// { started } — started=true when this call launched the sweep, started=false when one was already in
// flight (a no-op accept — never a duplicate overlapping sweep). The sweep is fire-and-forget: its result
// lands in /status + /runs (no run-id polling). A construction error (e.g. an unset EDGAR_USER_AGENT,
// which fails closed) degrades to a JSON 503 from the harvester.
export async function POST() {
  const r = await authedFetch('/admin/api/fundamentals-ingest/force-sweep', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
