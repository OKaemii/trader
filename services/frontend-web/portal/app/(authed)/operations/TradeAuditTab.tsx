import { authedFetch } from '@/app/lib/auth-fetch'
import { TradeAudit, type FillsPayload } from '@/components/TradeAudit'

// Trade Audit tab of the Operations workspace — the old /operations/trade-audit page body verbatim.
// The append-only fills ledger (fills_history, demo/live), filterable by ticker / side / window.
// The forensic "what actually executed, when, at what price" view (G5/G7). SSR-seed the last 30d.
export async function TradeAuditTab() {
  const r = await authedFetch('/admin/api/trading/fills?days=30')
  const data: FillsPayload | null = r.ok ? await r.json().catch(() => null) : null

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-400">
        Executed fills from the append-only ledger (demo/live). Filter by ticker, side, and window.
      </p>
      {data ? (
        <TradeAudit initial={data} />
      ) : (
        <div className="rounded border border-amber-900 bg-amber-950 px-4 py-2 text-sm text-amber-300">
          {r.status === 400
            ? 'Fills are only recorded in demo/live mode.'
            : r.status === 401 || r.status === 403
              ? 'Admin role required.'
              : `Fills unavailable (${r.status}).`}
        </div>
      )}
    </div>
  )
}
