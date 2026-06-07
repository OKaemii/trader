import { NextResponse } from 'next/server'
import { getSystemHealth } from '@/app/lib/system-health'

// Browser-reachable proxy for the client StrategyHealthBanner poll. The fan-out itself
// lives in @/app/lib/system-health (shared with the server-component callers); this route
// just JSON-wraps it so /portal-api/admin/system/health stays a fetchable endpoint.
export async function GET() {
  return NextResponse.json(await getSystemHealth())
}
