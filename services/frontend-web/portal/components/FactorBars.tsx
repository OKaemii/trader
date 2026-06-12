'use client'

import { useEffect, useState } from 'react'
import { FreshnessTag } from './FreshnessTag'

// Per-symbol research-factor percentile bars (research-trading-os Task 24 §E). The four
// strategy-independent research factors — Momentum / Quality / Value / Volatility — each shown
// as its cross-sectional percentile (0–100) over the universe for the latest factor_scores cycle.
//
// REUSED BY the universal research drawer (Task 35), which is client-only by construction, so this
// is a CLIENT component that self-fetches from the portal proxy by ticker. A server surface can
// hand it a server-seeded snapshot via `initial` (avoids a client round-trip on first paint and
// keeps SSR honest); the drawer mounts it with just `ticker` and lets it fetch. Either way the
// public contract is the same: `<FactorBars ticker="AAPL_US_EQ" initial={…?} />`.
//
// HONESTY RULE (plan §E + sdlc): a factor the strategy couldn't compute this cycle arrives with
// `pct: null` — it renders an explicit "—" / "unknown" bar, NEVER a fabricated 0. The store also
// degrades a pre-backfill / unknown ticker to `{}`, which surfaces as "not yet computed".

export type FactorKey = 'momentum' | 'quality' | 'value' | 'volatility'

/** One factor cell off the scores store: cross-sectional percentile + raw z plus its source tag.
 *  `pct` is null when the factor couldn't be computed this cycle (rendered as "—", never 0). */
export interface FactorCell {
  raw: number | null
  pct: number | null
  source?: string | null
}

/** The `?ticker=` scores shape from /admin/api/strategy/scores (Task 10): one row per name. An
 *  empty `{}` (pre-backfill / unknown ticker) is a valid, non-error response. */
export interface FactorScores {
  ticker?: string
  observation_ts?: number
  /** Freshness verdict stamped by the scores proxy: true = not live (older than the last session) ·
   *  false = live · null/undefined = undeterminable. Drives the "as of <time> · Not live" header tag. */
  stale?: boolean | null
  factors?: Partial<Record<FactorKey, FactorCell>>
}

// Display order + the human label and a one-line meaning for each factor. The meaning text states
// what a HIGH percentile means so the bar isn't read with the wrong polarity (high Volatility
// percentile = MORE volatile = typically less attractive, unlike the other three).
const FACTOR_META: Array<{ key: FactorKey; label: string; high: string }> = [
  { key: 'momentum', label: 'Momentum', high: 'higher = stronger recent trend' },
  { key: 'quality', label: 'Quality', high: 'higher = stronger fundamentals (QMJ)' },
  { key: 'value', label: 'Value', high: 'higher = cheaper vs peers' },
  { key: 'volatility', label: 'Volatility', high: 'higher = more volatile' },
]

// Bar colour by percentile band — quiet palette, consistent with the rest of the portal. This is
// a magnitude scale (where the name sits in the cross-section), NOT a good/bad scale, since the
// "good" direction differs per factor (see FACTOR_META.high).
function bandColour(pct: number): string {
  if (pct >= 80) return 'bg-emerald-500'
  if (pct >= 60) return 'bg-teal-500'
  if (pct >= 40) return 'bg-sky-500'
  if (pct >= 20) return 'bg-indigo-500'
  return 'bg-slate-500'
}

function FactorRow({ label, high, cell }: { label: string; high: string; cell?: FactorCell }) {
  const pct = cell?.pct
  // A computed percentile is a finite number in [0,100]; anything else (null/undefined/NaN) is
  // "not computed this cycle" → explicit "—", never a 0-width bar that reads as a real low score.
  const hasPct = typeof pct === 'number' && Number.isFinite(pct)
  const clamped = hasPct ? Math.min(100, Math.max(0, pct)) : 0
  return (
    <div className="flex items-center gap-3" title={high}>
      <span className="w-20 shrink-0 text-xs text-gray-400">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded bg-gray-800">
        {hasPct && (
          <div
            className={`h-full ${bandColour(clamped)} transition-all`}
            style={{ width: `${clamped.toFixed(1)}%` }}
          />
        )}
      </div>
      <span className="w-16 shrink-0 text-right font-mono text-xs">
        {hasPct ? (
          <span className="text-gray-200">{Math.round(clamped)}</span>
        ) : (
          <span className="text-gray-500" title="not computed this cycle">
            — <span className="text-[10px] uppercase tracking-wide">unknown</span>
          </span>
        )}
      </span>
    </div>
  )
}

export function FactorBars({
  ticker,
  initial = null,
}: {
  ticker: string
  /** Optional server-seeded scores so SSR surfaces render with no client round-trip. `null` ⇒
   *  fetch on mount; `{}` is a valid seed meaning "store has nothing for this ticker yet". */
  initial?: FactorScores | null
}) {
  // `null` ⇒ still loading the client fetch; a `FactorScores` (incl. `{}`) ⇒ resolved. Seeded
  // surfaces start resolved with the seed; the no-seed case (the drawer) starts null and fetches on
  // mount. A consumer that swaps `ticker` on a long-lived no-seed instance should mount this with
  // `key={ticker}` so React remounts it (fresh null/loading state) rather than briefly showing the
  // prior symbol's bars — this keeps the component free of a setState-in-effect reset.
  const [scores, setScores] = useState<FactorScores | null>(initial)

  useEffect(() => {
    if (initial !== null) return
    let cancelled = false
    fetch(`/portal-api/admin/strategy/scores?ticker=${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((body: FactorScores) => {
        if (!cancelled) setScores(body ?? {})
      })
      .catch(() => {
        // A failed fetch is not the same as "no scores" — show an honest empty state, not zeros.
        if (!cancelled) setScores({})
      })
    return () => {
      cancelled = true
    }
  }, [ticker, initial])

  if (scores === null) {
    return <div className="h-24 animate-pulse rounded-lg bg-gray-800" />
  }

  const factors = scores?.factors
  // Empty store / unknown ticker / pre-backfill → the endpoint returns `{}` (no `factors`). Make
  // that legible rather than rendering four "—" rows that imply we tried and failed per factor.
  const hasAnyFactor = !!factors && FACTOR_META.some(({ key }) => factors[key] !== undefined)

  return (
    <div className="space-y-3 rounded-lg bg-gray-900 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">Factor percentiles</h2>
        <div className="flex items-center gap-2">
          {typeof scores?.observation_ts === 'number' && (
            <FreshnessTag asOf={scores.observation_ts} stale={scores.stale ?? null} />
          )}
          <span className="text-[10px] uppercase tracking-wide text-gray-500">vs universe</span>
        </div>
      </div>
      {hasAnyFactor ? (
        <div className="space-y-2">
          {FACTOR_META.map(({ key, label, high }) => (
            <FactorRow key={key} label={label} high={high} cell={factors?.[key]} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-400">
          Factor scores not yet computed for{' '}
          <span className="font-mono text-gray-300">{ticker}</span> — the factor store backfills per
          strategy cycle.
        </p>
      )}
    </div>
  )
}
