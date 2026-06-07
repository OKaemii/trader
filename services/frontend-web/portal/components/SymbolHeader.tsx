import { authedFetch } from '@/app/lib/auth-fetch'
import { MarketBadge } from '@/components/MarketBadge'
import { marketOf } from '@/components/market'

// Symbol-workspace header (research-trading-os Task 24 — plan §E). The ticker identity strip the
// Research shell (research/page.tsx) renders once, above whichever question-tab is active, when in
// `?symbol=` mode — so a downstream tab never re-renders the identity.
//
// Task 24 fleshes the Task 23 stub into a real header: name/sector resolved from the active
// universe + a market badge + last close and day change from the persisted daily bars. It is an
// async SERVER component that owns its own authedFetch (the shell mounts it with just `symbol`).
//
// PROP CONTRACT (stable — extend the body, not the signature): `{ symbol, name? }`. `symbol` is the
// in-universe ticker (e.g. 'AAPL_US_EQ'); `name` is an optional caller-supplied override (a caller
// that already has the display name can pass it to skip the universe lookup). The page passes only
// `symbol`, so the lookup is the default path.
//
// HONESTY: a value we can't resolve (name not in the universe, no recent bars) renders nothing /
// "—" rather than a fabricated price or a 0% change.

interface UniverseEntry {
  ticker?: string
  name?: string
  sector?: string
}

interface RawBar {
  observation_ts?: number
  timestamp?: number
  close: number
}

/** Resolve display name + sector from the active universe. Best-effort: a failed/absent upstream,
 *  or a symbol not in the active set, just yields `{}` (the header degrades to ticker-only). */
async function fetchIdentity(symbol: string): Promise<{ name?: string; sector?: string }> {
  try {
    const r = await authedFetch('/admin/api/market-data/universe/overrides')
    if (!r.ok) return {}
    const body = (await r.json().catch(() => null)) as {
      activeUniverseDetailed?: UniverseEntry[]
      sectorMap?: Record<string, string>
    } | null
    if (!body) return {}
    const hit = body.activeUniverseDetailed?.find((d) => d.ticker === symbol)
    const sector = hit?.sector ?? body.sectorMap?.[symbol]
    return {
      name: hit?.name && hit.name.length > 0 ? hit.name : undefined,
      sector: sector && sector.length > 0 ? sector : undefined,
    }
  } catch {
    return {}
  }
}

/** Last close + 1-day change from the persisted daily series. Best-effort — fewer than two bars
 *  (or a failed fetch) yields no price (header shows ticker/name only, never a fabricated quote). */
async function fetchLastPrice(
  symbol: string,
): Promise<{ last: number; changePct: number | null } | null> {
  try {
    const r = await authedFetch(`/admin/api/market-data/bars/${encodeURIComponent(symbol)}?interval=daily&range=60d`)
    if (!r.ok) return null
    const data = (await r.json().catch(() => null)) as { bars?: RawBar[] } | null
    const bars = data?.bars
    if (!bars || bars.length === 0) return null
    const last = bars[bars.length - 1]!.close
    if (!Number.isFinite(last)) return null
    const prev = bars.length >= 2 ? bars[bars.length - 2]!.close : undefined
    const changePct =
      prev !== undefined && Number.isFinite(prev) && prev !== 0 ? (last - prev) / prev : null
    return { last, changePct }
  } catch {
    return null
  }
}

export async function SymbolHeader({ symbol, name }: { symbol: string; name?: string }) {
  // Resolve name/sector only when the caller didn't supply a name (saves the universe fetch in the
  // drawer/embedded cases that already know it).
  const [identity, price] = await Promise.all([
    name ? Promise.resolve<{ name?: string; sector?: string }>({ name }) : fetchIdentity(symbol),
    fetchLastPrice(symbol),
  ])
  const market = marketOf(symbol)
  const ccy = market === 'LSE' ? 'GBP' : market === 'US' ? 'USD' : ''
  const change = price?.changePct

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-gray-800 pb-4">
      <span className="font-mono text-xl font-semibold text-white">{symbol}</span>
      {identity.name && <span className="text-sm text-gray-400">{identity.name}</span>}
      <MarketBadge market={market} />
      {identity.sector && (
        <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-400">
          {identity.sector}
        </span>
      )}
      {price && (
        <span className="ml-auto flex items-baseline gap-2">
          <span className="font-mono text-lg text-white">
            {price.last.toFixed(2)}
            {ccy && <span className="ml-1 text-xs text-gray-500">{ccy}</span>}
          </span>
          {change !== null && change !== undefined ? (
            <span
              className={`font-mono text-sm ${change >= 0 ? 'text-green-400' : 'text-red-400'}`}
              title="1-day change (last two daily closes)"
            >
              {change >= 0 ? '+' : ''}
              {(change * 100).toFixed(2)}%
            </span>
          ) : (
            <span className="text-sm text-gray-500" title="prior close unavailable">
              —
            </span>
          )}
        </span>
      )}
    </div>
  )
}
