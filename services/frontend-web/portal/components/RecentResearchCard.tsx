import Link from 'next/link'
import type { ResearchSummaryRow } from '@/app/lib/research-summary'

// Command-center "Recent Research" snapshot: a compact, read-only view of the latest
// validation/backtest runs (server-seeded from /admin/api/backtest/results). It deliberately
// does NOT embed the full ResearchView (runners + jobs queue) — that is the /research workspace;
// here we only surface the freshest verdicts at a glance and link through.

function formatRanAt(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

// `rows === null` means the fetch failed (likely the admin-only endpoint without a role);
// an empty array means "no runs yet". Distinguish so the operator isn't told "no research"
// when the call actually 403'd.
export function RecentResearchCard({ rows }: { rows: ResearchSummaryRow[] | null }) {
  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">Recent Research</h2>
        <Link href="/research" className="text-xs text-emerald-400 hover:text-emerald-300">
          View all →
        </Link>
      </div>
      {rows === null ? (
        <div className="text-sm text-gray-500">Results endpoint unavailable (admin role required).</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-gray-500">No validation runs yet.</div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <li
              key={`${r.strategy}-${r.ranAt}-${i}`}
              className="flex items-center justify-between gap-3 rounded bg-gray-950 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-gray-200">{r.strategy}</span>
                  <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-400">
                    {r.engine}
                  </span>
                </div>
                {r.ranAt && <div className="mt-0.5 text-xs text-gray-500">{formatRanAt(r.ranAt)}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="font-mono text-xs text-gray-400" title="Out-of-sample Sharpe">
                  {r.sharpe}
                </span>
                {r.beatsMarket !== null && (
                  <span
                    className={r.beatsMarket ? 'text-emerald-400' : 'text-amber-300'}
                    title={r.beatsMarket ? 'Beats benchmark' : 'Lags benchmark'}
                  >
                    {r.beatsMarket ? '↑ mkt' : '↓ mkt'}
                  </span>
                )}
                <span
                  className={`rounded px-2 py-0.5 text-xs font-semibold ${
                    r.passed ? 'bg-emerald-700 text-white' : 'bg-red-700 text-white'
                  }`}
                >
                  {r.verdict}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
