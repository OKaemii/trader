import { NextRequest, NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

export async function GET(req: NextRequest) {
  const qs = req.nextUrl.search
  const upstream = await authedFetch(`/admin/api/backtest/results${qs}`)
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
