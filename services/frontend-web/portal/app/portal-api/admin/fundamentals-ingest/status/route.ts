import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// PIT-fundamentals ingestion status → fundamentals-ingestion /admin/api/fundamentals-ingest/status.
// Coverage (covered instruments + facts + oldest period), ingestion lag, last force run, quarantine
// summary, and feed-health (effective EDGAR UA + provenance + ingest-enabled). The Operations
// PIT-fundamentals panel body. snake_case payload — surfaced as-is.
export async function GET() {
  const r = await authedFetch('/admin/api/fundamentals-ingest/status')
  const body = await r.json().catch(() => null)
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
