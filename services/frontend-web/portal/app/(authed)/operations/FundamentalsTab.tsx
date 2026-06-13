import { authedFetch } from '@/app/lib/auth-fetch'
import { FundamentalsIngestPanel } from '@/components/FundamentalsIngestPanel'
import { getUniverseOverrides } from '@/app/actions/admin'

// PIT Fundamentals tab of the Operations workspace — the operator surface over the fundamentals-
// HARVESTER (the per-CIK Parquet lake's write path), repointed off the retired Timescale ingestion
// service by epic pit-fundamentals-lake-rearchitecture (Task 21). Monitors the lake (covered CIKs,
// bootstrap state, last sweep, lake size), shows the per-name freshness + live-source state, and forces
// a sweep on demand. SSR-seeds the harvester /status + /config + /freshness + /runs and the live
// strategy fundamentals-source so the panel paints without an on-mount flicker, then the client polls.
//
// The harvester has NO Mongo, so the freshness audit takes the universe as an INPUT (?symbols=). The
// portal supplies the active universe (BARE symbols, derived from the universe-overrides
// activeUniverseDetailed.market — never the broker suffix). All fetches run server-side through the
// proxy (admin JWT attached); only this tab's fetches run when it's the active tab. The freshness +
// source reads degrade to null independently (a cold/unreachable upstream never blanks the panel).
//
// There is NO quarantine panel and NO EDGAR-UA editor here (the lake design drops quarantine — decision
// D; the harvester has no config-PUT). Distinct from Research › Fundamentals (per-symbol company
// financials) — this is the run-the-platform lake view.
export async function FundamentalsTab() {
  // The active universe (bare US symbols) the freshness audit is run over. Best-effort — a failure
  // leaves an empty list, in which case the harvester defaults to the lake's currently-listed tickers.
  const overrides = await getUniverseOverrides()
  const universeSymbols = overrides.ok
    ? (overrides.data.activeUniverseDetailed ?? [])
        .filter((i) => i.market === 'US')
        .map((i) => i.ticker.replace(/_US_EQ$/, '')) // detailed.ticker is still the T212 form on the wire
        .filter(Boolean)
    : []
  const symbolsQs = universeSymbols.length
    ? `?symbols=${encodeURIComponent(universeSymbols.slice(0, 600).join(','))}`
    : ''

  const [statusRes, configRes, freshnessRes, sourceRes, runsRes] = await Promise.all([
    authedFetch('/admin/api/fundamentals-ingest/status'),
    authedFetch('/admin/api/fundamentals-ingest/config'),
    authedFetch(`/admin/api/fundamentals-ingest/freshness${symbolsQs}`),
    authedFetch('/admin/api/strategy/fundamentals-source'),
    authedFetch('/admin/api/fundamentals-ingest/runs'),
  ])
  const initialStatus = statusRes.ok ? await statusRes.json().catch(() => null) : null
  const initialConfig = configRes.ok ? await configRes.json().catch(() => null) : null
  const initialFreshness = freshnessRes.ok ? await freshnessRes.json().catch(() => null) : null
  const initialSource = sourceRes.ok ? await sourceRes.json().catch(() => null) : null
  const initialRuns = runsRes.ok ? await runsRes.json().catch(() => null) : null

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-400">
        PIT-fundamentals harvester (US SEC EDGAR → per-CIK Parquet lake). Monitor lake coverage and sweep
        health, force a sweep, and see the per-name freshness + live-source state.
      </p>
      {!statusRes.ok && (statusRes.status === 401 || statusRes.status === 403) ? (
        <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          Admin role required.
        </div>
      ) : (
        <FundamentalsIngestPanel
          initialStatus={initialStatus}
          initialConfig={initialConfig}
          initialFreshness={initialFreshness}
          initialSource={initialSource}
          initialRuns={initialRuns}
          universeSymbols={universeSymbols}
        />
      )}
    </div>
  )
}
