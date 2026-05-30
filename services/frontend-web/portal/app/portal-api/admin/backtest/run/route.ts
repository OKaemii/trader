import { NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'
import { forwardJson } from '@/app/lib/proxy-json'

export async function POST(req: NextRequest) {
  const body = await req.text()
  const upstream = await authedFetch('/admin/api/backtest/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  return forwardJson(upstream)
}
