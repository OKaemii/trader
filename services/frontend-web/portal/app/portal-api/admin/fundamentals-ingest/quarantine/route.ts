import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Per-name PIT-fundamentals quarantine lookup → fundamentals-ingestion
// /admin/api/fundamentals-ingest/quarantine. Forwards an optional ?symbol= so the operator can scope
// the QA hold-out forensics to one ticker: returns { resolved, symbol, instrument_id, total,
// by_reason, by_sector, recent[] } (an unknown symbol resolves to instrument_id:-1 + resolved:false,
// an honest empty — never the full unfiltered set). Omitting ?symbol= returns the global summary.
// Backs the <QuantOnly> per-name quarantine lookup in the Operations PIT-fundamentals panel.
export async function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get('symbol')
  const qs = symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''
  const r = await authedFetch(`/admin/api/fundamentals-ingest/quarantine${qs}`)
  const body = await r.json().catch(() => null)
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
