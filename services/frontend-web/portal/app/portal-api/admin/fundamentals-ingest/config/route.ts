import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// PIT-fundamentals harvester config → fundamentals-HARVESTER /admin/api/fundamentals-ingest/config.
// GET-only: the harvester's effective env knobs — { lake_dir, sweep_minutes, watchlist, watchlist_mode,
// edgar_reqs_per_sec, edgar_user_agent_set }. The UA is surfaced only as a boolean (set ⇔ a contact is
// present); the harvester never echoes the contact string. There is NO config PUT — the harvester's
// config is deploy-time env on the harvester chart (the old portal-editable EDGAR-UA override belonged
// to the retired Timescale ingestion service). Read-only.
export async function GET() {
  const r = await authedFetch('/admin/api/fundamentals-ingest/config')
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
