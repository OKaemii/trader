import { getMarketDataConfig, getMarketDataProviderInfo } from '@/app/actions/admin'
import { MarketDataEditor } from '@/components/MarketDataEditor'
import { SessionSavingsTile } from '@/components/SessionSavingsTile'
import { authedFetch } from '@/app/lib/auth-fetch'
import { MarketStateBadge, type MarketState } from '@/components/MarketStateBadge'

// Market Data tab (relocated to Operations — was app/(authed)/research/MarketDataTab.tsx).
// This is the OPERATIONAL market-data admin (poll config / calendar / holiday feeds) — a
// run-the-platform concern, not per-symbol research — so it lives beside Trade Audit /
// Reconciliation / TCA. Company/price *data* stays in Research. Composes three surfaces:
//  - the BAR_FREQUENCY / POLL_INTERVAL_MS / SIGNAL_ORDER_TYPE editor (was
//    app/(authed)/market-data/page.tsx), still on the server-action data path
//    (getMarketDataConfig/getMarketDataProviderInfo),
//  - the Yahoo-calls-saved-by-gate tile, and
//  - the per-exchange session schedule + holiday-source health grid (was
//    app/(authed)/market-data/calendar/page.tsx).

// --- session/holiday calendar (verbatim from market-data/calendar/page.tsx) ---------

// Wire shape from market-data-service GET /admin/api/market-data/calendar?days=30.
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
  // Mirror of HolidaySourceHealth['source'] (packages/shared-calendar/src/calendar.ts —
  // the upstream union, + 'never' from HolidayCache when no table has been fetched). 'eodhd'
  // is the EODHD Exchange-Details provider (Task 18), now the primary US source ahead of the
  // static fallback. Keep this in sync with the upstream union.
  source:         'eodhd' | 'ical' | 'gov-uk' | 'cache' | 'static-fallback' | 'never'
  ageMs:          number | null
}

interface SourceHealthResponse {
  generatedAt: number
  sources:     SourceHealthRow[]
}

async function fetchCalendar(): Promise<CalendarResponse | null> {
  try {
    const r = await authedFetch('/admin/api/market-data/calendar?days=30')
    if (!r.ok) return null
    return (await r.json()) as CalendarResponse
  } catch {
    return null
  }
}

async function fetchSources(): Promise<SourceHealthResponse | null> {
  try {
    const r = await authedFetch('/admin/api/market-data/holiday-sources')
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

async function MarketCalendarSection() {
  const [cal, sources] = await Promise.all([fetchCalendar(), fetchSources()])

  if (!cal) {
    return (
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-white">Market Calendar</h2>
        <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          Calendar endpoint unavailable. Admin role required, or the market-data-service
          is still bootstrapping.
        </div>
      </section>
    )
  }

  const nextOpen: string | null = null

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Market Calendar</h2>
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
        <div key={m}>
          <h3 className="mb-2 text-sm font-medium text-gray-300">{m} — next {cal.days} days</h3>
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
        </div>
      ))}

      <div>
        <h3 className="mb-2 text-sm font-medium text-gray-300">Holiday source health</h3>
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
      </div>
    </section>
  )
}

// --- editor + tile (verbatim data path from market-data/page.tsx) --------------------

export async function MarketDataTab() {
  const [cfg, prov] = await Promise.all([
    getMarketDataConfig(),
    getMarketDataProviderInfo(),
  ])

  if (!cfg.ok) {
    return (
      <div className="space-y-6">
        <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          {cfg.status === 401 || cfg.status === 403
            ? 'Admin role required.'
            : `Failed to load (${cfg.status}).`}
        </div>
      </div>
    )
  }

  // Provider-info failure is non-fatal — the editor falls back to the free-form ms
  // input. Most likely cause is an older market-data-service that doesn't expose the
  // endpoint yet.
  const providerInfo = prov.ok ? prov.data : null

  return (
    <div className="space-y-6">
      <MarketDataEditor initial={cfg.data} providerInfo={providerInfo} />
      <SessionSavingsTile />
      <MarketCalendarSection />
    </div>
  )
}
