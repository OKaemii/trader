import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Operator-controls state (kill switch + pause) → signal-service /admin/api/signals/risk/controls.
export async function GET() {
  const r = await authedFetch('/admin/api/signals/risk/controls')
  const body = await r.json().catch(() => ({ killSwitch: false, paused: false }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
