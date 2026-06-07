'use client'

import { useEffect, useState } from 'react'
import { Markdown } from '@/components/ui/Markdown'

// "Today's Market" — the data-grounded market-state prose (plan §F, Task 31). Renders the hybrid
// narrative from signal-service's research module (GET /admin/api/market/narrative via the
// /portal-api proxy, T30) through the shared sanitized <Markdown> renderer (T2).
//
// The narrative is built from a templated-NLG skeleton that already contains every figure in the
// /admin/api/market/summary payload; an LLM phrases it fluently, but a post-check rejects any number
// not in the payload and falls back to the deterministic skeleton. `source` tells the operator which
// path produced the prose they're reading — 'llm' = fluently phrased and number-checked, 'template'
// = the raw deterministic skeleton (LLM unavailable / disabled / its output failed the number check).
// We surface that subtly so the operator never mistakes the deterministic fallback for LLM prose.
//
// Pre-first-cycle is graceful by construction: the endpoint always returns words (the skeleton
// renders the factor/breadth legs as "not yet computed" until strategy-engine's first factor cycle
// lands), and `asOf` may be null — we render the prose regardless and only show the as-of stamp when
// it exists.
//
// SSR-seed + client-refresh, mirroring the portal's CashCard/FactorBars pattern: pass `initial` from
// a server component so the panel paints populated on first byte, then it refreshes once on mount
// only if it was NOT seeded (an unseeded mount, e.g. the Discover tab, fetches through the proxy).
// The narrative is cached per-UTC-day upstream, so there is no live poll — a once-a-day concept does
// not need a 15s timer.

// Mirror of the T30 endpoint payload. We read only the fields this panel renders; `summary` (the full
// MarketSummary the prose was built from) is intentionally NOT pulled in — the prose already contains
// every figure, and importing the service-side MarketSummary type into a client component is exactly
// what AGENTS.md "Don't" warns against.
export interface NarrativePayload {
  narrative: string
  source: 'llm' | 'template'
  asOf: number | null
  tradingDay: string
  generatedAt: number
  cached: boolean
}

function asOfLabel(asOf: number | null, tradingDay: string): string {
  // Prefer the factor-cycle knowledge time when present; before the first cycle it is null, so fall
  // back to the trading day the narrative was generated for (always present).
  if (asOf != null) {
    return `as of ${new Date(asOf).toUTCString()}`
  }
  return `for ${tradingDay}`
}

// 'llm' vs 'template' badge. The fallback (template) is the one the operator must be able to spot —
// it is the deterministic skeleton, not number-checked LLM prose — so it gets the warmer amber chip;
// the LLM path gets a quiet gray chip (it's the expected steady state, not something to flag).
function SourceBadge({ source }: { source: 'llm' | 'template' }) {
  const isTemplate = source === 'template'
  return (
    <span
      title={
        isTemplate
          ? 'Deterministic template — LLM phrasing unavailable or its output failed the numbers check.'
          : 'LLM-phrased — numbers checked against the market summary payload.'
      }
      className={
        isTemplate
          ? 'rounded border border-amber-900 bg-amber-950 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300'
          : 'rounded border border-gray-700 bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-400'
      }
    >
      {isTemplate ? 'Template' : 'LLM'}
    </span>
  )
}

export function MarketNarrative({ initial }: { initial?: NarrativePayload | null }) {
  // null = unseeded (a parent that didn't SSR-fetch) → fetch on mount. A seeded null (the endpoint
  // genuinely errored on the server) is passed as `undefined` by the parent so this still fetches.
  const [data, setData] = useState<NarrativePayload | null>(initial ?? null)
  const [loaded, setLoaded] = useState<boolean>(initial != null)

  useEffect(() => {
    // Only self-fetch when not SSR-seeded — avoids the on-mount flicker the Workspace page's seed
    // already prevents, while still letting an unseeded mount (Discover) populate itself.
    if (initial != null) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/portal-api/admin/market/narrative', { cache: 'no-store' })
        if (!res.ok) {
          if (!cancelled) setLoaded(true)
          return
        }
        const body = (await res.json().catch(() => null)) as NarrativePayload | null
        if (!cancelled) {
          if (body && typeof body.narrative === 'string') setData(body)
          setLoaded(true)
        }
      } catch {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [initial])

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Today&apos;s Market</h2>
        {data && <SourceBadge source={data.source} />}
      </div>
      <div className="rounded border border-gray-800 bg-gray-900 p-4">
        {data ? (
          <>
            <Markdown>{data.narrative}</Markdown>
            <p className="mt-3 border-t border-gray-800 pt-2 text-[11px] text-gray-600">
              {asOfLabel(data.asOf, data.tradingDay)}
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-500">
            {loaded ? 'Market narrative unavailable.' : 'Loading market narrative…'}
          </p>
        )}
      </div>
    </section>
  )
}

export default MarketNarrative
