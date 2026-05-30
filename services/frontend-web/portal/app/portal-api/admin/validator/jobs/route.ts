import { NextRequest, NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// List recent validation jobs (status summary; the large report bodies are excluded upstream).
export async function GET(req: NextRequest) {
  const qs = req.nextUrl.search
  const upstream = await authedFetch(`/admin/api/validator/jobs${qs}`)
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
