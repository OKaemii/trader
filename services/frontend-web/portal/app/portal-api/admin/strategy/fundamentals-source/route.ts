import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Live strategy fundamentals-source → strategy-engine /admin/api/strategy/fundamentals-source.
// What the live cycle actually read+built per ticker: { provider, sources:{<src>:count},
// by_ticker:{ticker:{source, built_at}}, pit_served, last_cycle_ts }. Drives the Operations
// PIT-fundamentals summary (live source line) + the per-ticker table's read+built clock column.
// Source values are surfaced verbatim (incl. a raw null source). Read-only.
export async function GET() {
  const r = await authedFetch('/admin/api/strategy/fundamentals-source')
  const body = await r.json().catch(() => null)
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
