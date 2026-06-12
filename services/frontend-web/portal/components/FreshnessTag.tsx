// A small "as of <time> · LIVE / NOT LIVE" badge for any market-data-derived figure. Pairs with
// `app/lib/freshness.ts` (which computes `stale`): when markets are closed and the data predates the
// last session, the surface shows the last-available value WITH this tag rather than silently
// presenting stale numbers as current.
//
// Presentational + pure (no hooks, no fetch) so it renders in both server and client trees. Timestamps
// are formatted in UTC deterministically to avoid SSR/client locale hydration drift.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fmtAsOf(ms: number): string {
  const d = new Date(ms)
  const day = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${day} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm} UTC`
}

export function FreshnessTag({
  asOf,
  stale,
  className = '',
}: {
  /** The datum's observation_ts (ms). Null ⇒ render nothing (no honest as-of to show). */
  asOf: number | null
  /** true = not live · false = live · null = undeterminable (show the as-of time, no state claim). */
  stale: boolean | null
  className?: string
}) {
  if (asOf === null) return null
  const asOfText = fmtAsOf(asOf)
  const tone =
    stale === true
      ? 'bg-amber-900/50 text-amber-300'
      : stale === false
        ? 'bg-emerald-900/50 text-emerald-300'
        : 'bg-gray-800 text-gray-400'
  const title =
    stale === true
      ? `Not live — showing the last available data (as of ${asOfText}). The market has closed or moved on since this was computed.`
      : stale === false
        ? `Live — this data is from the current session (${asOfText}).`
        : `Showing data as of ${asOfText}.`
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone} ${className}`}
      title={title}
    >
      {stale !== null && <span>{stale ? 'Not live' : 'Live'}</span>}
      <span className="font-normal normal-case opacity-80">as of {asOfText}</span>
    </span>
  )
}
