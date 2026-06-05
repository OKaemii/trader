import { NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'
import { forwardJson } from '@/app/lib/proxy-json'

// Backfill DeepSeek explanations for recent reports that don't have one yet (cached on the row).
export async function POST(req: NextRequest) {
  const qs = req.nextUrl.search
  const upstream = await authedFetch(`/admin/api/backtest/results/explain${qs}`, { method: 'POST' })
  return forwardJson(upstream)
}
