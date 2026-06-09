import { provenanceKind } from '@/app/lib/fundamentals-merge'

// Reusable per-ticker fundamentals provenance badge (plan §J). One honest label for "where did this
// name's fundamentals come from": PIT = OUR point-in-time SEC-EDGAR warehouse (source 'pit-edgar');
// Yahoo = a THIRD-PARTY snapshot (source 'yahoo-snapshot'); none = no source row yet (rendered '—').
//
// The bucketing is NOT re-implemented here — it reuses fundamentals-merge.ts's provenanceKind so the
// badge, the Operations summary, and the filter all agree on what counts as PIT vs Yahoo. Fed a raw
// `source` string per ticker (the strategy fundamentals-source by_ticker map's value, or the scanner
// snapshot row's per-name source — both carry the same 'pit-edgar' | 'yahoo*' | null vocabulary). The
// raw source surfaces on hover (title) so the operator can see the exact upstream behind the bucket.
//
// Extracted from the inline tag in FundamentalsIngestPanel (card 149) so it can also tag the scanner
// rows + later positions/signals from the same map, with identical labels everywhere.

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
