// Shared placeholder chrome for the Research question-tab scaffolds (research-trading-os
// Task 23 — plan §E). The shell card scaffolds all five tabs (Overview / Signals / Strategy
// Impact / Fundamentals / History) so downstream cards (T24–T28) each fill ONE tab's body
// without touching page.tsx or the other tabs. Until a tab is filled, it renders this dashed
// "coming soon" frame with a short description of what it will show.
//
// A tab card replaces its own body (the children it passes / the whole file) and can drop this
// import once its real content lands; the other tabs keep using it independently.
export function ScaffoldBody({
  tab,
  symbol,
  children,
}: {
  tab: string
  symbol: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded border border-dashed border-gray-800 bg-gray-900/40 p-6">
      <h2 className="text-sm font-medium text-gray-300">
        {tab} · <span className="font-mono text-gray-400">{symbol}</span>
      </h2>
      <p className="mt-2 text-sm text-gray-500">{children}</p>
    </div>
  )
}
