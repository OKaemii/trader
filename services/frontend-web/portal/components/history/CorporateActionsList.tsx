// Corporate-actions list for the History tab (T28, plan §E/§H) — dividends + splits from the
// market-data corporate_actions store (T14: GET /admin/api/market-data/corporate-actions?ticker=).
// Server-rendered, read-only. Shapes mirror T14's StoredDividend / StoredSplit (BASE units; pence
// already killed at the market-data boundary, so we never re-scale here). A local mirror keeps the
// service-internal type out of any client graph (portal AGENTS.md "Don't import service types").
export interface StoredDividend {
  date: string // 'YYYY-MM-DD' ex-date
  valuePerShare: number // BASE units (GBP/USD)
  currency?: string
}
export interface StoredSplit {
  date: string // 'YYYY-MM-DD' split-effective
  ratio: string // e.g. '2/1'
  factor: number // share-count multiplier; NaN ⇒ "don't auto-adjust"
}

// Merge the two event streams into one reverse-chronological table so the operator reads the
// symbol's corporate history top-down (newest first) regardless of action type.
type Row =
  | { kind: 'dividend'; date: string; valuePerShare: number; currency?: string }
  | { kind: 'split'; date: string; ratio: string; factor: number }

export function CorporateActionsList({
  dividends, splits,
}: { dividends: StoredDividend[]; splits: StoredSplit[] }) {
  const rows: Row[] = [
    ...dividends.map((d) => ({ kind: 'dividend' as const, date: d.date, valuePerShare: d.valuePerShare, currency: d.currency })),
    ...splits.map((s) => ({ kind: 'split' as const, date: s.date, ratio: s.ratio, factor: s.factor })),
  ].sort((a, b) => b.date.localeCompare(a.date))

  if (rows.length === 0) {
    return (
      <div className="rounded border border-gray-800 bg-gray-900/40 p-6 text-sm text-gray-400">
        No dividends or splits on record for this symbol. (The corporate-actions feed syncs
        incrementally — a freshly-added ticker fills in over the next sync pass.)
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded border border-gray-800">
      <table className="w-full text-sm">
        <thead className="bg-gray-900 text-left text-xs uppercase text-gray-400">
          <tr>
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">Detail</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800 bg-gray-950">
          {rows.map((r) => (
            <tr key={`${r.kind}-${r.date}`}>
              <td className="px-3 py-2 font-mono text-gray-300">{r.date}</td>
              <td className="px-3 py-2">
                {r.kind === 'dividend' ? (
                  <span className="text-emerald-400">Dividend</span>
                ) : (
                  <span className="text-amber-300">Split</span>
                )}
              </td>
              <td className="px-3 py-2 text-gray-300">
                {r.kind === 'dividend' ? (
                  <span>
                    {r.valuePerShare.toFixed(4)} {r.currency ?? ''} / share
                  </span>
                ) : (
                  // The raw EODHD ratio is the operator-meaningful label; `factor` is the parsed
                  // share-count multiplier we keep only when it parsed (NaN ⇒ don't auto-adjust).
                  <span>
                    {r.ratio}
                    {Number.isFinite(r.factor) ? (
                      <span className="ml-2 text-gray-500">({r.factor}×)</span>
                    ) : (
                      <span className="ml-2 text-gray-600">(unparsed)</span>
                    )}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
