import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// "Rebalance now" → runs one strategy cycle on demand via strategy-engine's /admin/api/strategy/replay,
// with force_rebalance:true so a monthly strategy (high_velocity_v1) bypasses its RebalanceClock and
// rebalances immediately instead of waiting for the month boundary. Two server-side hops so the browser
// never needs the universe or the upstream paths:
//   1. fetch the active universe from market-data (the tickers the cycle ranks over),
//   2. POST the replay with that universe + force_rebalance.
// Body: { dryRun?: boolean } — dryRun:true previews (computes, no orders); false (default) publishes →
// signal-service → the dispatcher places orders in whichever TRADING_MODE is configured.
export async function POST(req: Request) {
  const { dryRun } = (await req.json().catch(() => ({}))) as { dryRun?: boolean }

  const uniRes = await authedFetch('/admin/api/market-data/universe/overrides')
  if (!uniRes.ok) {
    return NextResponse.json({ error: `could not load active universe (${uniRes.status})` }, { status: uniRes.status })
  }
  const uni = (await uniRes.json().catch(() => ({}))) as { activeUniverse?: string[] }
  const universe = uni.activeUniverse ?? []
  if (universe.length === 0) {
    return NextResponse.json({ error: 'active universe is empty — refresh the universe first' }, { status: 409 })
  }

  const r = await authedFetch('/admin/api/strategy/replay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ universe, dry_run: dryRun === true, force_rebalance: true }),
  })
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
