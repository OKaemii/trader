import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Poll one force-ingest run → fundamentals-ingestion /admin/api/fundamentals-ingest/runs/{run_id}.
// State (running|done|failed) + counts + timing, the poll target after a force trigger. 404 when the
// id is unknown to the serving pod (the run store is in-process). Next 16: dynamic params are a Promise.
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params
  const r = await authedFetch(`/admin/api/fundamentals-ingest/runs/${encodeURIComponent(runId)}`)
  const body = await r.json().catch(() => ({}))
  return NextResponse.json(body, { status: r.status })
}
