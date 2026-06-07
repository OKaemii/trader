import { authedFetch } from '@/app/lib/auth-fetch'
import { trailing12mDividend, sortDividendsDesc } from '@/app/lib/dividends'

// Fundamentals tab — per-symbol company financials (research-trading-os Task 27, plan §E/§H).
//
// DATA SOURCES (all clearly marked in the UI, per §H — EODHD Fundamentals is NOT entitled):
//   • company_fundamentals (Yahoo, monthly-TTL CURRENT SNAPSHOT) — the QMJ line items + ratios +
//     market cap, via /admin/api/market-data/fundamentals/:ticker (peek; no provider walk here).
//     Grouped Valuation / Profitability / Balance Sheet. There is NO deep historical fundamentals
//     source, so these are a point-in-time snapshot, never a backfillable history.
//   • Corporate-actions Dividends (EODHD, point-in-time) — trailing-12m dividend-per-share + the
//     full dividend history, via /admin/api/market-data/corporate-actions?ticker= (Task 14).
//   • Analyst estimates (Yahoo quoteSummary, additive — MAY TRAIL) — best-effort price target,
//     recommendation, and forward EPS/revenue growth, folded into the fundamentals/:ticker payload.
//     Null when Yahoo's session is unavailable; the rest of the tab still renders.
//
// PROP CONTRACT: async server component taking exactly `{ symbol }` (see OverviewTab) — the
// in-universe ticker (e.g. 'AAPL_US_EQ'). page.tsx guarantees a non-empty symbol before mounting.

interface FundamentalsRaw {
  netIncome: number
  totalEquity: number
  totalDebt: number
  currentAssets: number
  currentLiabilities: number
  marketCapGbp: number
}
interface QmjRatios {
  roe: number
  debtToEquity: number
  currentRatio: number
}
interface RecommendationHistogram {
  strongBuy: number
  buy: number
  hold: number
  sell: number
  strongSell: number
}
interface GrowthEstimate {
  period: string
  growth: number | null
}
// Mirror of the market-data-service YahooAnalystEstimates shape (display-only, never imported
// cross-service per the portal AGENTS.md "no service-internal types in the portal" rule).
interface AnalystEstimates {
  priceTargetLow: number | null
  priceTargetMean: number | null
  priceTargetHigh: number | null
  numberOfAnalysts: number | null
  recommendationMean: number | null
  recommendationKey: string | null
  recommendation: RecommendationHistogram | null
  earningsGrowth: GrowthEstimate[]
  revenueGrowth: GrowthEstimate[]
}
interface FundamentalsResponse {
  ticker: string
  raw: FundamentalsRaw | null
  ratios: QmjRatios | null
  qualityPass: boolean | null
  marketCapGbp: number | null
  asOf: number | null
  source: string | null
  analyst: AnalystEstimates | null
}
// From /admin/api/market-data/corporate-actions (Task 14 release notes).
interface StoredDividend {
  date: string // 'YYYY-MM-DD' ex-date
  valuePerShare: number // BASE units (pence already killed at the boundary)
  currency?: string
}
interface CorporateActionsResponse {
  ticker: string
  dividends: StoredDividend[]
  lastDividendDate: string | null
  asOf: number | null
}

// ── formatters ──────────────────────────────────────────────────────────────────────────────────
const DASH = '—'
function pct(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? DASH : `${(v * 100).toFixed(digits)}%`
}
function ratio(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(v) ? DASH : v.toFixed(digits)
}
function num(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(v) ? DASH : v.toLocaleString('en-GB', { maximumFractionDigits: digits })
}
// Market cap is stored in GBP; render compactly (£B / £M).
function gbpCompact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH
  if (v >= 1e9) return `£${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `£${(v / 1e6).toFixed(1)}M`
  return `£${v.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
}
function curSym(c?: string): string {
  return c === 'USD' ? '$' : c === 'GBP' ? '£' : ''
}

function SourceTag({ label }: { label: string }) {
  return (
    <span className="ml-2 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
      {label}
    </span>
  )
}

function Group({ title, source, children }: { title: string; source: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-gray-800 bg-gray-900/40 p-4">
      <h3 className="flex items-center text-xs font-semibold uppercase tracking-wide text-gray-300">
        {title}
        <SourceTag label={source} />
      </h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">{children}</dl>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="font-mono text-sm text-gray-100">{value}</dd>
      {hint ? <dd className="text-[10px] text-gray-600">{hint}</dd> : null}
    </div>
  )
}

export async function FundamentalsTab({ symbol }: { symbol: string }) {
  // Both reads are independent — fetch in parallel. Each degrades to null/empty on a non-OK status
  // so one upstream hiccup never blanks the whole tab.
  const [fr, cr] = await Promise.all([
    authedFetch(`/admin/api/market-data/fundamentals/${encodeURIComponent(symbol)}`),
    authedFetch(`/admin/api/market-data/corporate-actions?ticker=${encodeURIComponent(symbol)}`),
  ])
  const fund: FundamentalsResponse | null = fr.ok ? await fr.json().catch(() => null) : null
  const actions: CorporateActionsResponse | null = cr.ok ? await cr.json().catch(() => null) : null

  const raw = fund?.raw ?? null
  const ratios = fund?.ratios ?? null
  const analyst = fund?.analyst ?? null
  const dividends = sortDividendsDesc(actions?.dividends ?? [])
  // `asOf` (the store's sync time) anchors the trailing-12m window; the helper defaults to "now"
  // when it's null, keeping the impure clock-read out of this render path.
  const t12 = trailing12mDividend(dividends, actions?.asOf)
  // Dividend yield needs a price denominator; the portal doesn't hold one cheaply here, so we show
  // the trailing-12m payout per share (the honest, source-only figure) and the history table rather
  // than fabricating a yield from a stale price.
  const haveFundamentals = !!raw && (raw.totalEquity !== 0 || raw.marketCapGbp !== 0)

  return (
    <div className="space-y-4">
      <div className="rounded border border-amber-900/40 bg-amber-950/20 p-3 text-xs text-amber-200/80">
        Company financials are a <span className="font-medium">current Yahoo snapshot</span> (monthly
        TTL) — EODHD Fundamentals is not entitled, so there is no deep historical fundamentals series.
        Dividend history is point-in-time from the EODHD Dividends feed. Analyst estimates are
        best-effort Yahoo and may trail.
        {fund?.asOf ? (
          <span className="ml-1 text-amber-200/60">
            Fundamentals snapshot {new Date(fund.asOf).toLocaleDateString('en-GB')}.
          </span>
        ) : null}
      </div>

      {!haveFundamentals ? (
        <div className="rounded border border-dashed border-gray-800 bg-gray-900/40 p-4 text-sm text-gray-500">
          No fundamentals snapshot cached for{' '}
          <span className="font-mono text-gray-400">{symbol}</span> yet. The QMJ refresher populates
          company_fundamentals on its monthly walk, or an operator can force a refresh from the
          Scanner page. Dividend history (below) is independent and may still be present.
        </div>
      ) : (
        <>
          <Group title="Valuation" source="Yahoo">
            <Stat label="Market cap" value={gbpCompact(raw?.marketCapGbp)} hint="FX-normalised to GBP" />
            {fund?.qualityPass != null ? (
              <Stat
                label="QMJ quality"
                value={fund.qualityPass ? 'Pass' : 'Fail'}
                hint="ROE≥10% · D/E≤2 · Current≥1"
              />
            ) : null}
          </Group>

          <Group title="Profitability" source="Yahoo">
            <Stat label="Return on equity" value={pct(ratios?.roe)} hint="net income / equity (annual)" />
            <Stat label="Net income" value={num(raw?.netIncome, 0)} hint="latest fiscal year (native units)" />
          </Group>

          <Group title="Balance sheet" source="Yahoo">
            <Stat label="Total equity" value={num(raw?.totalEquity, 0)} />
            <Stat label="Total debt" value={num(raw?.totalDebt, 0)} />
            <Stat label="Debt / equity" value={ratio(ratios?.debtToEquity)} />
            <Stat label="Current assets" value={num(raw?.currentAssets, 0)} />
            <Stat label="Current liabilities" value={num(raw?.currentLiabilities, 0)} />
            <Stat label="Current ratio" value={ratio(ratios?.currentRatio)} hint="current assets / liabilities" />
          </Group>
        </>
      )}

      <Group title="Growth (forward estimates)" source="Yahoo · est">
        {analyst && (analyst.earningsGrowth.length > 0 || analyst.revenueGrowth.length > 0) ? (
          <>
            {analyst.earningsGrowth.map((g) => (
              <Stat key={`eps-${g.period}`} label={`EPS growth (${g.period})`} value={pct(g.growth)} />
            ))}
            {analyst.revenueGrowth.map((g) => (
              <Stat key={`rev-${g.period}`} label={`Revenue growth (${g.period})`} value={pct(g.growth)} />
            ))}
          </>
        ) : (
          <p className="col-span-full text-xs text-gray-600">No forward growth estimates available.</p>
        )}
      </Group>

      <Group title="Analyst estimates" source="Yahoo · may trail">
        {analyst ? (
          <>
            <Stat
              label="Price target (mean)"
              value={num(analyst.priceTargetMean)}
              hint={
                analyst.priceTargetLow != null && analyst.priceTargetHigh != null
                  ? `low ${num(analyst.priceTargetLow)} · high ${num(analyst.priceTargetHigh)}`
                  : undefined
              }
            />
            <Stat
              label="Recommendation"
              value={analyst.recommendationKey ? analyst.recommendationKey.replace(/_/g, ' ') : DASH}
              hint={analyst.recommendationMean != null ? `mean ${ratio(analyst.recommendationMean)} (1=buy, 5=sell)` : undefined}
            />
            <Stat label="Covering analysts" value={num(analyst.numberOfAnalysts, 0)} />
            {analyst.recommendation ? (
              <Stat
                label="Ratings"
                value={`${analyst.recommendation.strongBuy + analyst.recommendation.buy} buy · ${analyst.recommendation.hold} hold · ${analyst.recommendation.sell + analyst.recommendation.strongSell} sell`}
              />
            ) : null}
          </>
        ) : (
          <p className="col-span-full text-xs text-gray-600">
            Analyst estimates unavailable (Yahoo quoteSummary did not return data).
          </p>
        )}
      </Group>

      <div className="rounded border border-gray-800 bg-gray-900/40 p-4">
        <h3 className="flex items-center text-xs font-semibold uppercase tracking-wide text-gray-300">
          Dividends
          <SourceTag label="EODHD" />
        </h3>
        {dividends.length === 0 ? (
          <p className="mt-3 text-xs text-gray-600">
            No dividend history on file (non-payer, or not yet synced).
          </p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
              <Stat
                label="Trailing-12m dividend"
                value={`${curSym(t12.currency)}${num(t12.total, 4)} / share`}
                hint="sum of ex-dates in the last year"
              />
              <Stat label="Payments on file" value={num(dividends.length, 0)} />
              {actions?.lastDividendDate ? (
                <Stat label="Latest ex-date" value={actions.lastDividendDate} />
              ) : null}
            </div>
            <table className="mt-4 w-full text-left text-xs">
              <thead className="text-gray-500">
                <tr>
                  <th className="py-1 font-medium">Ex-date</th>
                  <th className="py-1 text-right font-medium">Per share</th>
                </tr>
              </thead>
              <tbody className="font-mono text-gray-200">
                {dividends.slice(0, 12).map((d) => (
                  <tr key={d.date} className="border-t border-gray-800/60">
                    <td className="py-1">{d.date}</td>
                    <td className="py-1 text-right">
                      {curSym(d.currency)}
                      {num(d.valuePerShare, 4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {dividends.length > 12 ? (
              <p className="mt-2 text-[10px] text-gray-600">
                Showing the 12 most recent of {dividends.length} payments.
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
