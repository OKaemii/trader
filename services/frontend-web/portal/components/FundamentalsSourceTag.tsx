import { provenanceKind } from '@/app/lib/fundamentals-merge'

// Reusable per-name fundamentals provenance badge. One honest label for "where did this name's
// fundamentals come from": PIT = OUR point-in-time SEC-EDGAR lake (source 'pit-edgar'); none = no
// fundamentals source this cycle (rendered '—' — a non-US name fail-closes to no fundamentals, or a
// US name whose quality factor couldn't be computed).
//
// Post Yahoo-removal (epic pit-fundamentals-lake-rearchitecture, Thread C) the LIVE vocabulary reduces
// to 'pit-edgar' | null — the 'yahoo-snapshot' stamp is retired from the live cycle. The 'Yahoo' badge
// is kept ONLY as a defensive label for a HISTORICAL stored row that still carries the retired stamp
// (read, never freshly written); a live surface should only ever show PIT or —.
//
// The bucketing is NOT re-implemented here — it reuses fundamentals-merge.ts's provenanceKind so the
// badge, the Operations summary, and the filter all agree. Fed a raw `source` string per name (the
// strategy fundamentals-source by_ticker map's value, or the scanner snapshot row's per-name source).
// The raw source surfaces on hover (title) so the operator can see the exact upstream behind the bucket.

interface Props {
  source: string | null | undefined
  className?: string
}

export function FundamentalsSourceTag({ source, className = '' }: Props) {
  const kind = provenanceKind(source)
  const title = source ?? undefined

  if (kind === 'pit') {
    return (
      <span
        className={`rounded bg-emerald-950 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300 ${className}`}
        title={title}
      >
        PIT
      </span>
    )
  }
  if (kind === 'yahoo') {
    return (
      <span
        className={`rounded bg-gray-800 px-1.5 py-0.5 text-[11px] font-semibold text-gray-300 ${className}`}
        title={title}
      >
        Yahoo
      </span>
    )
  }
  return (
    <span className={`text-gray-600 ${className}`} title={title}>
      —
    </span>
  )
}
