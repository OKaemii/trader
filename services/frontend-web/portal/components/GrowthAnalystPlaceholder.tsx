// Growth + analyst-estimates placeholder for the Research Fundamentals tab (epic
// pit-fundamentals-lake-rearchitecture, Thread C / decision I). The Yahoo analyst-estimates source
// was dropped platform-wide and no point-in-time replacement is wired yet, so the forward-growth and
// analyst-estimate sections render a "PIT-sourced — coming soon" stub instead of stale Yahoo data.
//
// Pure presentational — no data fetch, no service-internal types — so the section never crashes the
// tab and a later epic can swap it for the real PIT-backed panel. The two cards mirror the prior
// "Growth (forward estimates)" and "Analyst estimates" groups so the tab's layout is unchanged.

function PlaceholderCard({ title }: { title: string }) {
  return (
    <div className="rounded border border-gray-800 bg-gray-900/40 p-4">
      <h3 className="flex items-center text-xs font-semibold uppercase tracking-wide text-gray-300">
        {title}
        <span className="ml-2 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
          PIT · coming soon
        </span>
      </h3>
      <p className="mt-3 text-xs text-gray-600">
        Not yet available — analyst estimates and forward growth will be sourced from point-in-time
        data in a later release. The Yahoo source has been retired.
      </p>
    </div>
  )
}

export function GrowthAnalystPlaceholder() {
  return (
    <>
      <PlaceholderCard title="Growth (forward estimates)" />
      <PlaceholderCard title="Analyst estimates" />
    </>
  )
}
