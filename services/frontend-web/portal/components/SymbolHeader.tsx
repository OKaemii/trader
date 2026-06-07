// Symbol-workspace header (research-trading-os Task 23 shell — plan §E).
//
// Scaffold: the ticker identity strip that sits above the active question-tab when the
// Research workspace is in `?symbol=` mode. The shell (research/page.tsx) renders it once,
// for every tab, so a downstream tab card never has to re-render the identity.
//
// Task 24 (Overview) fleshes this out — name/sector/market resolution from the universe,
// last price, day change, a SymbolPicker to switch symbol in place. Kept minimal here so
// the shell + the five tab scaffolds can land without that work; the prop contract (`symbol`,
// optional `name`) is the stable surface Task 24 extends, not replaces.
export function SymbolHeader({ symbol, name }: { symbol: string; name?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-gray-800 pb-4">
      <span className="font-mono text-xl font-semibold text-white">{symbol}</span>
      {name && <span className="text-sm text-gray-400">{name}</span>}
    </div>
  )
}
