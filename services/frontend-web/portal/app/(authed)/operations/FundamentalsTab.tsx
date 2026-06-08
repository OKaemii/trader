import { authedFetch } from '@/app/lib/auth-fetch'
import { FundamentalsIngestPanel } from '@/components/FundamentalsIngestPanel'

// PIT Fundamentals tab of the Operations workspace (card 134) — the operator surface over the
// fundamentals-ingestion write-side (the PIT Fundamentals Warehouse). Monitors ingestion (coverage,
// lag, last-run, quarantine, feed-health), forces a run on demand, and edits the EDGAR User-Agent the
// next run sends to SEC (portal_fundamentals_config override > env > default). SSR-seeds the status +
// effective config so the panel paints without an on-mount flicker, then the client polls + mutates.
// Both fetches run server-side through the proxy (admin JWT attached); only this tab's fetches run
// when it's the active tab. Distinct from Research › Fundamentals, which is per-symbol company
// financials — this is the run-the-platform ingestion view.
export async function FundamentalsTab() {
  const [statusRes, configRes] = await Promise.all([
    authedFetch('/admin/api/fundamentals-ingest/status'),
    authedFetch('/admin/api/fundamentals-ingest/config'),
  ])
  const initialStatus = statusRes.ok ? await statusRes.json().catch(() => null) : null
  const initialConfig = configRes.ok ? await configRes.json().catch(() => null) : null

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
        <FundamentalsIngestPanel initialStatus={initialStatus} initialConfig={initialConfig} />
      )}
    </div>
  )
}
