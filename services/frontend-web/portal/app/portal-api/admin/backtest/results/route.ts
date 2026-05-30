import { NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'
import { forwardJson } from '@/app/lib/proxy-json'

export async function GET(req: NextRequest) {
  const qs = req.nextUrl.search
  const upstream = await authedFetch(`/admin/api/backtest/results${qs}`)
  return forwardJson(upstream)
}
