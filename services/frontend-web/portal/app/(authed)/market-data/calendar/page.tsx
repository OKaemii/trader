import { authedFetch } from '@/app/lib/auth-fetch'
import { MarketStateBadge, type MarketState } from '@/components/MarketStateBadge'

// Wire shape from market-data-service GET /api/admin/market-data/calendar?days=30.
interface ScheduledSession {
  date:      string         // 'YYYY-MM-DD' exchange-local
  market:    'US' | 'LSE'
  isOpen:    boolean
  isHalfDay: boolean
  openMs:    number | null
  closeMs:   number | null
}

interface CalendarResponse {
  generatedAt: number
  days:        number
  current:     Record<'US' | 'LSE', MarketState>
  schedule:    { US: ScheduledSession[]; LSE: ScheduledSession[] }
}

interface SourceHealthRow {
  market:         'US' | 'LSE'
  lastFetchedAt:  number | null
  source:         'ical' | 'gov-uk' | 'cache' | 'static-fallback' | 'never'
  ageMs:          number | null
}

interface SourceHealthResponse {
  generatedAt: number
  sources:     SourceHealthRow[]
}

async function fetchCalendar(): Promise<CalendarResponse | null> {
  try {
    const r = await authedFetch('/api/admin/market-data/calendar?days=30')
    if (!r.ok) return null
    return (await r.json()) as CalendarResponse
  } catch {
    return null
  }
}

async function fetchSources(): Promise<SourceHealthResponse | null> {
  try {
    const r = await authedFetch('/api/admin/market-data/holiday-sources')
    if (!r.ok) return null
    return (await r.json()) as SourceHealthResponse
  } catch {
    return null
  }
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return '—'
  const h = ageMs / 3_600_000
  if (h < 1) return `${Math.round(ageMs / 60_000)}m ago`
  if (h < 48) return `${h.toFixed(1)}h ago`
  return `${(h / 24).toFixed(1)}d ago`
}

function sourceBadgeClass(source: SourceHealthRow['source'], ageMs: number | null): string {
  if (source === 'static-fallback' || source === 'never') return 'text-red-400'
  if (ageMs !== null && ageMs > 7 * 24 * 3_600_000) return 'text-amber-400'
  return 'text-emerald-400'
}

function dayCellClass(s: ScheduledSession): string {
  if (!s.isOpen)   return 'bg-gray-800 text-gray-500'
  if (s.isHalfDay) return 'bg-amber-900/40 text-amber-200'
  return 'bg-emerald-900/40 text-emerald-200'
}

function formatTime(ms: number | null): string {
  if (ms === null) return ''
  return new Date(ms).toUTCString().slice(17, 22)   // 'HH:MM' UTC
}

export default async function CalendarPage() {
  const [cal, sources] = await Promise.all([fetchCalendar(), fetchSources()])

  if (!cal) {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-bold text-white">Market Calendar</h1>
        <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          Calendar endpoint unavailable. Admin role required, or the market-data-service
          is still bootstrapping.
        </div>
      </div>
    )
  }

  const nextOpen: string | null = null

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Market Calendar</h1>
          <p className="mt-1 text-sm text-gray-400">
            Per-exchange session schedule + holiday-source health. Powers the
            session-aware Yahoo poll gate.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MarketStateBadge market="US"  state={cal.current.US}  nextOpen={nextOpen} />
          <MarketStateBadge market="LSE" state={cal.current.LSE} nextOpen={nextOpen} />
        </div>
      </div>

      {(['US', 'LSE'] as const).map((m) => (
        <section key={m}>
          <h2 className="mb-2 text-sm font-medium text-gray-300">{m} — next {cal.days} days</h2>
          <div className="grid grid-cols-7 gap-1 md:grid-cols-15">
            {cal.schedule[m].map((s) => (
              <div
                key={s.date}
                title={s.isOpen
                  ? `${s.date} ${formatTime(s.openMs)}–${formatTime(s.closeMs)} UTC${s.isHalfDay ? ' (half-day)' : ''}`
                  : `${s.date} closed`}
                className={`rounded px-1.5 py-1 text-center text-[10px] font-mono ${dayCellClass(s)}`}
              >
                <div>{s.date.slice(5)}</div>
                {s.isOpen && <div className="opacity-70">{formatTime(s.openMs)}</div>}
              </div>
            ))}
          </div>
        </section>
      ))}

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-300">Holiday source health</h2>
        {sources === null ? (
          <div className="text-sm text-gray-500">Source health unavailable.</div>
        ) : (
          <table className="w-full table-auto border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-2 py-1">Market</th>
                <th className="px-2 py-1">Source</th>
                <th className="px-2 py-1">Last fetched</th>
                <th className="px-2 py-1">Age</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {sources.sources.map((s) => (
                <tr key={s.market} className="bg-gray-900">
                  <td className="px-2 py-1 text-gray-300">{s.market}</td>
                  <td className={`px-2 py-1 font-mono text-xs ${sourceBadgeClass(s.source, s.ageMs)}`}>{s.source}</td>
                  <td className="px-2 py-1 font-mono text-xs text-gray-400">
                    {s.lastFetchedAt ? new Date(s.lastFetchedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—'}
                  </td>
                  <td className={`px-2 py-1 font-mono text-xs ${sourceBadgeClass(s.source, s.ageMs)}`}>
                    {formatAge(s.ageMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-xs text-gray-500">
          Sources are refreshed weekly. `static-fallback` means both live providers AND
          the Mongo cache were unavailable on the most recent fetch — investigate.
        </p>
      </section>
    </div>
  )
}
