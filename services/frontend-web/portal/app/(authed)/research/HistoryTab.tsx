import { authedFetch } from '@/app/lib/auth-fetch'
import { ChartsView } from '@/components/ChartsView'
import { QuantOnly } from '@/components/QuantOnly'
import { ReturnsDrawdownChart, type HistoryPoint } from '@/components/history/ReturnsDrawdownChart'
import {
  CorporateActionsList,
  type StoredDividend,
  type StoredSplit,
} from '@/components/history/CorporateActionsList'
import { FactorEvolutionChart, type FactorHistoryPoint } from '@/components/history/FactorEvolutionChart'
import { TechnicalOverlays } from '@/components/history/TechnicalOverlays'
import { SignalHistoryList, type HistorySignal } from '@/components/history/SignalHistoryList'

// History tab — the symbol's full historical record (research-trading-os Task 28, plan §E/§H).
// Grows the Task-23 scaffold (the price/candlestick view) into the complete History surface:
//   • Price          — the reused candlestick/MA/RSI chart (ChartsView), client-polled.
//   • Returns/Drawdowns — cumulative price + TOTAL return (dividends reinvested) and the drawdown
//                       curve, computed from the daily bars + T14 corporate-actions dividends.
//   • Corporate Actions — dividends + splits from the T14 corporate_actions store.
//   • Technical overlays — supplemental EODHD indicators (MACD/ADX/ATR/Bollinger/beta), DISPLAY-only
//                       (factors stay in quant-core, §H), fetched on demand. Under <QuantOnly>.
//   • Factor Evolution — the four factor percentiles over time (T10 factor-history). Under <QuantOnly>.
//   • Signal History  — this symbol's signals, filtered from the recent feed.
//
// A server component can't fetch its own /portal-api/* proxy, so the SSR seeds call authedFetch on
// the upstream paths directly; the proxies (added/owned by the dependency cards + this one for
// technical) exist for the client polls. Each fetch degrades to an honest empty state on failure —
// a transient upstream blip must not crash the whole Research workspace render.
//
// PROP CONTRACT (Task 23 shell — extend the body, not the signature): async server component taking
// exactly `{ symbol }` (the in-universe ticker). page.tsx guarantees a non-empty symbol.
interface RawBar {
  observation_ts?: number
  timestamp?: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const r = await authedFetch(path)
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

// 'YYYY-MM-DD' (UTC) for a unix-ms instant — used to align dividend ex-dates onto bar days.
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export async function HistoryTab({ symbol }: { symbol: string }) {
  const enc = encodeURIComponent(symbol)
  // SSR every panel's seed in parallel so the tab paints fully populated on first byte.
  const [barsBody, caBody, factorBody, signalsBody] = await Promise.all([
    // 1y matches ChartsView's default range pill, so the seeded price chart and its control agree on
    // load; the same daily series feeds Returns/Drawdowns. A longer window is one range-pill click away.
    fetchJson<{ bars?: RawBar[] }>(`/admin/api/market-data/bars/${enc}?interval=daily&range=1y`),
    fetchJson<{ dividends?: StoredDividend[]; splits?: StoredSplit[] }>(
      `/admin/api/market-data/corporate-actions?ticker=${enc}`,
    ),
    fetchJson<{ points?: FactorHistoryPoint[] }>(`/admin/api/strategy/factor-history?ticker=${enc}`),
    // The recent-signals feed is NOT ticker-scoped (T25's by-ticker endpoint isn't built); we pull
    // the cap and filter to this symbol server-side. 200 is the feed's hard cap.
    fetchJson<{ signals?: HistorySignal[] }>(`/admin/api/signals/history?limit=200`),
  ])

  const rawBars = barsBody?.bars ?? []
  const chartBars = rawBars.map((b) => ({
    time: Math.floor((b.observation_ts ?? b.timestamp ?? 0) / 1000),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }))

  const dividends = caBody?.dividends ?? []
  const splits = caBody?.splits ?? []

  // Build the Returns/Drawdowns input: each bar's close + the dividend (if any) with an ex-date on
  // that day. Dividends are BASE units (pence already killed at the market-data boundary) — same
  // units as `close`, so the reinvestment growth factor is unit-consistent.
  const divByDay = new Map<string, number>()
  for (const d of dividends) divByDay.set(d.date, (divByDay.get(d.date) ?? 0) + d.valuePerShare)
  const historyPoints: HistoryPoint[] = chartBars
    .filter((b) => b.time > 0 && b.close > 0)
    .map((b) => ({
      time: b.time,
      close: b.close,
      divPerShare: divByDay.get(isoDay(b.time * 1000)) ?? 0,
    }))

  const factorPoints = factorBody?.points ?? []

  // Filter the recent feed to this symbol, newest-first (the feed is already desc by timestamp, but
  // sort defensively so the order is independent of the upstream's contract).
  const signals = (signalsBody?.signals ?? [])
    .filter((s) => s.ticker === symbol)
    .sort((a, b) => b.timestamp - a.timestamp)

  return (
    <div className="space-y-8">
      <Section title="Price">
        <p className="text-sm text-gray-400">
          Daily &amp; weekly candlesticks with 20/50/200-day moving averages, RSI, and volume. 4h is
          the shortest timeframe (best-effort — depends on 5m freshness).
        </p>
        <ChartsView initialTicker={symbol} initialBars={chartBars} />
      </Section>

      <Section title="Returns & Drawdowns">
        <ReturnsDrawdownChart points={historyPoints} />
      </Section>

      <Section title="Corporate Actions">
        <CorporateActionsList dividends={dividends} splits={splits} />
      </Section>

      <Section title="Signal History">
        <SignalHistoryList symbol={symbol} signals={signals} />
      </Section>

      {/* Advanced diagnostics — these ADD analytical depth and carry no safety surface, so Beginner
          mode curates them away (portal AGENTS.md: <QuantOnly> for factor/technical internals). */}
      <QuantOnly>
        <Section title="Factor Evolution">
          <FactorEvolutionChart points={factorPoints} />
        </Section>
        <Section title="Technical Overlays">
          <TechnicalOverlays symbol={symbol} />
        </Section>
      </QuantOnly>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      {children}
    </section>
  )
}
