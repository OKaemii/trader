// Signal History for the History tab (T28, plan §E) — every signal this symbol has produced,
// newest-first. Sourced by filtering the EXISTING recent-signals feed
// (GET /admin/api/signals/history) by ticker server-side (T25's dedicated by-ticker endpoint is not
// built yet — we deliberately don't depend on it). The feed is capped (≤200 recent signals), so this
// is "recent history for this symbol", stated honestly below.
//
// Local mirror of the minimal TradeSignalDTO fields we render — no service-internal enum leaks into
// the client graph (portal AGENTS.md). Lifecycle/action arrive as the numeric wire values.

// Mirror of SignalLifecycle (services/.../types/trader.ts) — the wire format is the numeric index;
// reorder = silent corruption, so this mirrors that enum's order exactly.
const LIFECYCLE_LABEL = [
  'Pending', 'Approved', 'Queued', 'Executing', 'Executed', 'Closed', 'Failed', 'Cancelled',
] as const

export interface HistorySignal {
  id: string
  timestamp: number
  ticker: string
  strategy_id: string
  action: 'BUY' | 'SELL' | 'HOLD'
  confidence: number
  lifecycle?: number
  entryPrice?: number
  exitPrice?: number
}

const fmtTs = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

function lifecycleLabel(lc?: number): string {
  return lc != null && lc >= 0 && lc < LIFECYCLE_LABEL.length ? LIFECYCLE_LABEL[lc]! : 'Pending'
}

function lifecycleTone(lc?: number): string {
  switch (lc) {
    case 4: // Executed
    case 5: // Closed
      return 'text-emerald-400'
    case 6: // Failed
    case 7: // Cancelled
      return 'text-red-400'
    default:
      return 'text-gray-400'
  }
}

export function SignalHistoryList({ symbol, signals }: { symbol: string; signals: HistorySignal[] }) {
  if (signals.length === 0) {
    return (
      <div className="rounded border border-gray-800 bg-gray-900/40 p-6 text-sm text-gray-400">
        No recent signals for <span className="font-mono text-gray-300">{symbol}</span>. (Shows the
        symbol&apos;s signals from the recent feed; an older history may exist beyond the feed window.)
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-400">
        Recent signals for <span className="font-mono text-gray-300">{symbol}</span>, newest first
        (filtered from the latest cycles&apos; feed).
      </p>
      <div className="overflow-x-auto rounded border border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-left text-xs uppercase text-gray-400">
            <tr>
              <th className="px-3 py-2">When (UTC)</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Strategy</th>
              <th className="px-3 py-2">Confidence</th>
              <th className="px-3 py-2">Lifecycle</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800 bg-gray-950">
            {signals.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-2 font-mono text-gray-300">
                  {/* The signal id is the email/bookmark deep-link target (a real detail page). */}
                  <a href={`/signals/${s.id}`} className="hover:text-emerald-400 hover:underline">
                    {fmtTs(s.timestamp)}
                  </a>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={
                      s.action === 'BUY'
                        ? 'text-emerald-400'
                        : s.action === 'SELL'
                          ? 'text-red-400'
                          : 'text-gray-400'
                    }
                  >
                    {s.action}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-gray-300">{s.strategy_id}</td>
                <td className="px-3 py-2 text-gray-300">{(s.confidence * 100).toFixed(0)}%</td>
                <td className={`px-3 py-2 ${lifecycleTone(s.lifecycle)}`}>{lifecycleLabel(s.lifecycle)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
