import { NextRequest, NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Enqueue an MCPT validation job (Phase 5/6). Returns {job_id} immediately — the run itself is
// hours of compute drained by backtest-engine's in-process JobRunner; the UI polls the job.
export async function POST(req: NextRequest) {
  const body = await req.text()
  const upstream = await authedFetch('/admin/api/validator/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
