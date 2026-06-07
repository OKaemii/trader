'use client'

import { useEffect, useState } from 'react'
import type { FactorKey, FactorCell, FactorScores } from '@/components/FactorBars'

// "Why?" panel for a single signal (research-trading-os Task 25 §F). A plain-English checklist of
// the factor gates that supported (or didn't) this signal, read from the factor_scores store
// AS-OF the signal's OWN timestamp — so it shows the percentiles the signal actually saw at
// emission, not today's. Point-in-time honesty: the asOf is signal.timestamp, never Date.now().
//
// REUSED BY the universal research drawer (Task 35), which is client-only by construction, so this
// is a CLIENT component that self-fetches the as-of scores from the portal proxy. A server surface
// (the Research Signals tab) hands it a server-seeded snapshot via `initial` to avoid a client
// round-trip on first paint; the drawer mounts it with just `symbol`/`asOf` and lets it fetch.
// Either way the public contract is `<WhyPanel symbol asOf action confidence initial={…?} />`.
//
// HONESTY RULE (plan §F + sdlc): a factor the strategy couldn't compute as-of this signal arrives
// with `pct: null` — its gate renders an explicit "—" / "no data", NEVER a fabricated pass/fail.
// A pre-backfill / unknown ticker degrades to `{}` (the as-of read returned nothing for this name
// at this instant) and the panel says so rather than inventing a checklist.

// Gate thresholds (percentile cut-offs, [0,100]). Each is the cross-sectional band the research
// factor must clear to count as a supporting reason. These mirror the "higher percentile = more
// desirable" convention every research factor follows (quant-core research_factors): volatility is
// stored as -realised-stdev, so a HIGH volatility percentile means LOW realised vol — hence the
// gate reads "Low volatility", not "high volatility".
const MOMENTUM_GATE = 90 // top decile — the 12-1 momentum signal the factor strategy keys on
const QUALITY_GATE = 70 // upper tercile QMJ (ROE / leverage / liquidity composite)
const VALUE_GATE = 70 // cheap vs peers (upper tercile of the value z-score percentile)
const LOW_VOL_GATE = 60 // above-median low-vol (high vol-percentile = low realised vol)

interface Gate {
  key: FactorKey
  // The supporting claim phrased so the ✓ reading is unambiguous regardless of factor polarity.
  label: (pct: number) => string
  gate: number
}

// Order = the factor strategy's own priority (momentum first — it's the primary driver), so the
// checklist reads as "the reasons, strongest first".
const GATES: Gate[] = [
  { key: 'momentum', gate: MOMENTUM_GATE, label: (p) => `Momentum > 90th pct (${Math.round(p)})` },
  { key: 'quality', gate: QUALITY_GATE, label: (p) => `Quality (QMJ) > 70th pct (${Math.round(p)})` },
  { key: 'value', gate: VALUE_GATE, label: (p) => `Cheap vs peers — value > 70th pct (${Math.round(p)})` },
  { key: 'volatility', gate: LOW_VOL_GATE, label: (p) => `Low volatility > 60th pct (${Math.round(p)})` },
]

function GateRow({ cell, label, gate }: { cell: FactorCell | undefined; label: (pct: number) => string; gate: number }) {
  const pct = cell?.pct
  const hasPct = typeof pct === 'number' && Number.isFinite(pct)
  if (!hasPct) {
    // Couldn't compute this factor as-of the signal — honest "no data", never a green or red.
    return (
      <li className="flex items-center gap-2 text-sm text-gray-500">
        <span aria-hidden className="w-4 text-center">—</span>
        <span>{label(0).replace(/\s*\(\d+\)$/, '')} — no data as-of this signal</span>
      </li>
    )
  }
  const passed = pct >= gate
  return (
    <li className={`flex items-center gap-2 text-sm ${passed ? 'text-emerald-300' : 'text-gray-400'}`}>
      <span aria-hidden className={`w-4 text-center ${passed ? 'text-emerald-400' : 'text-red-400'}`}>
        {passed ? '✓' : '✗'}
      </span>
      <span>{label(pct)}</span>
    </li>
  )
}

export function WhyPanel({
  symbol,
  asOf,
  action,
  confidence,
  initial = null,
}: {
  /** The in-universe ticker the signal is for. */
  symbol: string
  /** The signal's OWN emission timestamp (epoch ms) — the point-in-time knowledge cutoff the gates
   *  are read at. Using the signal's ts (not now) is the whole point of the Why? as-of read. */
  asOf: number
  /** Signal context — surfaced as a header chip; optional so the drawer can mount lean. */
  action?: 'BUY' | 'SELL' | 'HOLD'
  confidence?: number
  /** Optional server-seeded as-of scores so SSR surfaces render with no client round-trip. `null`
   *  ⇒ fetch on mount; `{}` is a valid seed meaning "nothing in the store for this name as-of". */
  initial?: FactorScores | null
}) {
  // `null` ⇒ still loading the client fetch; a `FactorScores` (incl. `{}`) ⇒ resolved. A seeded
  // surface starts resolved; the no-seed drawer case starts null and fetches on mount. A consumer
  // swapping symbol/asOf on a long-lived no-seed instance should remount with `key` to refetch.
  const [scores, setScores] = useState<FactorScores | null>(initial)

  useEffect(() => {
    if (initial !== null) return
    let cancelled = false
    fetch(
      `/portal-api/admin/strategy/scores?ticker=${encodeURIComponent(symbol)}&asOf=${encodeURIComponent(String(asOf))}`,
    )
      .then((r) => r.json())
      .then((body: FactorScores) => {
        if (!cancelled) setScores(body ?? {})
      })
      .catch(() => {
        // A failed fetch is not "no scores" — show an honest empty state, not a fabricated verdict.
        if (!cancelled) setScores({})
      })
    return () => {
      cancelled = true
    }
  }, [symbol, asOf, initial])

  if (scores === null) {
    return <div className="h-28 animate-pulse rounded-lg bg-gray-800" />
  }

  const factors = scores?.factors
  const hasAnyFactor = !!factors && GATES.some(({ key }) => factors[key] !== undefined)
  const supporting = hasAnyFactor
    ? GATES.filter(({ key, gate }) => {
        const p = factors?.[key]?.pct
        return typeof p === 'number' && Number.isFinite(p) && p >= gate
      }).length
    : 0

  return (
    <div className="space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">
          Why?{' '}
          {hasAnyFactor && (
            <span className="text-xs font-normal text-gray-500">
              {supporting} of {GATES.length} factor gates supported
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide">
          {action && (
            <span
              className={
                action === 'BUY' ? 'text-emerald-400' : action === 'SELL' ? 'text-red-400' : 'text-gray-400'
              }
            >
              {action}
            </span>
          )}
          {typeof confidence === 'number' && Number.isFinite(confidence) && (
            <span className="text-gray-500" title="signal confidence">
              conf {(confidence * 100).toFixed(0)}%
            </span>
          )}
        </div>
      </div>

      {hasAnyFactor ? (
        <>
          <ul className="space-y-1.5">
            {GATES.map(({ key, label, gate }) => (
              <GateRow key={key} cell={factors?.[key]} label={label} gate={gate} />
            ))}
          </ul>
          <p className="text-[11px] text-gray-500">
            Gates read as-of the signal&apos;s emission ({new Date(asOf).toISOString().slice(0, 10)}) — the
            cross-sectional percentiles it saw, not today&apos;s.
          </p>
        </>
      ) : (
        <p className="text-sm text-gray-400">
          No factor scores recorded for <span className="font-mono text-gray-300">{symbol}</span> as-of this
          signal — the factor store backfills per strategy cycle, so signals from before the backfill have no
          gate snapshot.
        </p>
      )}
    </div>
  )
}
