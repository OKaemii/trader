import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Portal-editable PIT-fundamentals config → fundamentals-ingestion /admin/api/fundamentals-ingest/config.
// GET: the EFFECTIVE config (override > env > default) the next run will use — the editable EDGAR UA +
//      its provenance (override/env/default), whether it is usable, the coverage cap, ingest-enabled.
// PUT: { edgarUserAgent?, coverageCap?, ingestEnabled? } (camelCase) — upserts the
//      portal_fundamentals_config singleton; an explicit null clears that override back to env/default.
//      Hot-applied cross-pod (config:invalidated). Returns the freshly-resolved effective config.
export async function GET() {
  const r = await authedFetch('/admin/api/fundamentals-ingest/config')
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}

export async function PUT(req: Request) {
  const payload = await req.json().catch(() => ({}))
  const r = await authedFetch('/admin/api/fundamentals-ingest/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
