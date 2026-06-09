import { authedFetch } from '@/app/lib/auth-fetch'
import { FundamentalsIngestPanel } from '@/components/FundamentalsIngestPanel'

// PIT Fundamentals tab of the Operations workspace (card 134, extended by card 149) — the operator
// surface over the fundamentals-ingestion write-side (the PIT Fundamentals Warehouse). Monitors
// ingestion (coverage, lag, last-run, quarantine, feed-health), shows the per-ticker freshness +
// live-source state, forces a run on demand, and edits the EDGAR User-Agent the next run sends to SEC
// (portal_fundamentals_config override > env > default). SSR-seeds status + effective config + the
// per-name freshness audit + the live strategy fundamentals-source map so the panel paints without an
// on-mount flicker, then the client polls. All four fetches run server-side through the proxy (admin
// JWT attached); only this tab's fetches run when it's the active tab. The freshness + source reads
// degrade to null independently (a cold/unreachable upstream never blanks the rest of the panel).
// Distinct from Research › Fundamentals, which is per-symbol company financials — this is the
// run-the-platform ingestion view.
export async function FundamentalsTab() {
  const [statusRes, configRes, freshnessRes, sourceRes] = await Promise.all([
    authedFetch('/admin/api/fundamentals-ingest/status'),
    authedFetch('/admin/api/fundamentals-ingest/config'),
    authedFetch('/admin/api/fundamentals-ingest/freshness'),
    authedFetch('/admin/api/strategy/fundamentals-source'),
  ])
  const initialStatus = statusRes.ok ? await statusRes.json().catch(() => null) : null
  const initialConfig = configRes.ok ? await configRes.json().catch(() => null) : null
  const initialFreshness = freshnessRes.ok ? await freshnessRes.json().catch(() => null) : null
  const initialSource = sourceRes.ok ? await sourceRes.json().catch(() => null) : null

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-400">
        PIT-fundamentals ingestion (US SEC EDGAR). Monitor coverage and feed health, force a backfill,
        and set the EDGAR User-Agent SEC fair-access requires.
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
        />
      )}
    </div>
  )
}
