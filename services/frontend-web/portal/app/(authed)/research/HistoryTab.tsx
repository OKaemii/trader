import { authedFetch } from '@/app/lib/auth-fetch'
import { ChartsView } from '@/components/ChartsView'

// History tab — per-symbol price/candlestick view (research-trading-os Task 23 shell).
//
// This folds in the price/candlestick view that the relocation pass (Task 22) parked under
// the `history` placeholder (formerly ChartsTab, formerly app/(authed)/charts/page.tsx), so
// the /charts → /research?tab=history stub still renders a chart. Daily/weekly are the swing
// default; 4h is the shortest (best-effort intraday). 20/50/200 MA + RSI + volume render
// client-side over the fetched OHLCV; the SSR seed comes from the same
// /admin/api/market-data/bars endpoint ChartsView polls.
//
// SCAFFOLD for downstream: Task 28 grows this into the full History tab — Price/Returns/
// Drawdowns, Technical overlays, Corporate Actions, Factor Evolution, Signal History — by
// extending the body below; the chart stays as the price view.
//
// PROP CONTRACT: async server component taking exactly `{ symbol }` (see OverviewTab) — the
// ticker whose history to chart. The no-symbol /charts stub path supplies a default via the
// shell, so this tab itself always receives a concrete symbol.
interface RawBar {
  observation_ts?: number
  timestamp?: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export async function HistoryTab({ symbol }: { symbol: string }) {
  const r = await authedFetch(`/admin/api/market-data/bars/${symbol}?interval=daily&range=1y`)
  const data = r.ok ? await r.json().catch(() => null) : null
  const bars = ((data?.bars ?? []) as RawBar[]).map((b) => ({
    time: Math.floor((b.observation_ts ?? b.timestamp ?? 0) / 1000),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }))

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-400">
        Daily &amp; weekly candlesticks with 20/50/200-day moving averages, RSI, and volume. 4h is
        the shortest timeframe (best-effort — depends on 5m freshness).
      </p>
      <ChartsView initialTicker={symbol} initialBars={bars} />
    </div>
  )
}
