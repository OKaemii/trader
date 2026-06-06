import { TcaView } from '@/components/TcaView'
import { authedFetch } from '@/app/lib/auth-fetch'

// TCA tab of the Operations workspace — the old /operations/tca page body verbatim. Per-fill
// slippage vs the mid-quote at order-send (arrival) and at fill, in basis points. SSR-seed the
// daily + recent series; populated in demo/live as orders fill.
async function seed() {
  try {
    const r = await authedFetch('/admin/api/trading/tca?limit=100')
    if (!r.ok) return { daily: [], recent: [] }
    const d = await r.json()
    return { daily: d.daily ?? [], recent: d.recent ?? [] }
  } catch {
    return { daily: [], recent: [] }
  }
}

export async function TcaTab() {
  const { daily, recent } = await seed()
  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-400">
        Per-fill slippage vs the mid-quote at order-send (arrival) and at fill, in basis points.
        Positive = worse than the reference mid. Coverage shows how many fills had a fresh quote;
        fills against synthetic quotes are noisier. Populated in demo/live as orders fill.
      </p>
      <TcaView initialDaily={daily} initialRecent={recent} />
    </div>
  )
}
