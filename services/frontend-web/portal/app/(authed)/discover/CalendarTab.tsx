import { authedFetch } from '@/app/lib/auth-fetch'
import { EarningsWarning } from '@/components/EarningsWarning'
import { CalendarView, type EarningsEvent } from '@/components/CalendarView'

// Calendar tab of the Discover workspace — the old /calendar page body verbatim.
// Earnings & dividends tied to positions. Holding through a surprise report is the biggest
// avoidable swing-trade disaster, so positions reporting within 10 days are flagged.
export async function CalendarTab() {
  const r = await authedFetch('/admin/api/market-data/earnings/upcoming?days=30')
  const data = r.ok ? await r.json().catch(() => null) : null
  const events: EarningsEvent[] = data?.events ?? []

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-400">
        Upcoming earnings and dividend dates (next 30 days). Names you hold are highlighted; any
        holding reporting within 10 days is flagged in red.
      </p>
      <EarningsWarning />
      {r.ok ? (
        <CalendarView initial={events} />
      ) : (
        <div className="rounded border border-amber-900 bg-amber-950 px-4 py-2 text-sm text-amber-300">
          {r.status === 401 || r.status === 403 ? 'Admin role required.' : `Calendar unavailable (${r.status}).`}
        </div>
      )}
    </div>
  )
}
