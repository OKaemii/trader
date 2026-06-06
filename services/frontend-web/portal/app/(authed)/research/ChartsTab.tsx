import { authedFetch } from '@/app/lib/auth-fetch'
import { ChartsView } from '@/components/ChartsView'

const DEFAULT_TICKER = 'AAPL_US_EQ'

interface RawBar { observation_ts?: number; timestamp?: number; open: number; high: number; low: number; close: number; volume: number }

// Charts tab (IA-redesign Task 8 — was app/(authed)/charts/page.tsx). Daily/weekly are
// the swing default; 4h is the shortest (best-effort intraday). 20/50/200 MA + RSI +
// volume render client-side over the fetched OHLCV. The SSR seed comes from the same
// /admin/api/market-data/bars endpoint ChartsView polls client-side.
export async function ChartsTab() {
  const r = await authedFetch(`/admin/api/market-data/bars/${DEFAULT_TICKER}?interval=daily&range=1y`)
  const data = r.ok ? await r.json().catch(() => null) : null
  const bars = ((data?.bars ?? []) as RawBar[]).map((b) => ({
    time: Math.floor((b.observation_ts ?? b.timestamp ?? 0) / 1000),
    open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
  }))

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-400">
        Daily &amp; weekly candlesticks with 20/50/200-day moving averages, RSI, and volume. 4h is
        the shortest timeframe (best-effort — depends on 5m freshness).
      </p>
      <ChartsView initialTicker={DEFAULT_TICKER} initialBars={bars} />
    </div>
  )
}
