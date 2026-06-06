import { authedFetch } from '@/app/lib/auth-fetch'
import { PositionsPanel, type EnrichedPosition } from '@/components/PositionsPanel'

// Positions tab (Portfolio workspace) — the body of the old /positions page verbatim:
// open holdings joined with the swing trade plan (entry, stop, target, days held, R-multiple).
// Stop distance is always visible; swing trading lives and dies on honouring stops.
// Rendered only when its tab is active, so this is the only authedFetch that runs for that tab.
export async function PositionsTab() {
  const r = await authedFetch('/admin/api/signals/positions/enriched')
  const data = r.ok ? await r.json().catch(() => null) : null
  const positions: EnrichedPosition[] = data?.positions ?? []

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Open positions with your trade plan — entry, stop, target, days held, and R-multiple
        (current gain ÷ initial risk). Set a stop/target inline; the stop distance is always shown.
      </p>
      {data ? (
        <PositionsPanel initial={positions} />
      ) : (
        <div className="rounded border border-amber-900 bg-amber-950 px-4 py-2 text-sm text-amber-300">
          {r.status === 401 || r.status === 403 ? 'Admin role required.' : `Positions unavailable (${r.status}).`}
        </div>
      )}
    </div>
  )
}
