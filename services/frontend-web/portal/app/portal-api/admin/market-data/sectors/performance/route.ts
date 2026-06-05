import { NextResponse, type NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

export async function GET(req: NextRequest) {
  const weeks = req.nextUrl.searchParams.get('weeks') ?? '13'
  const upstream = await authedFetch(`/admin/api/market-data/sectors/performance?weeks=${encodeURIComponent(weeks)}`)
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
