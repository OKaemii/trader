import { TcaView } from '@/components/TcaView'
import { authedFetch } from '@/app/lib/auth-fetch'

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

export default async function TcaPage() {
  const { daily, recent } = await seed()
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Transaction-cost analysis</h1>
        <p className="mt-1 text-sm text-gray-400">
          Per-fill slippage vs the mid-quote at order-send (arrival) and at fill, in basis points.
          Positive = worse than the reference mid. Coverage shows how many fills had a fresh quote;
          fills against synthetic quotes are noisier. Populated in demo/live as orders fill.
        </p>
      </div>
      <TcaView initialDaily={daily} initialRecent={recent} />
    </div>
  )
}
