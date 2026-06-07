import { authedFetch } from '@/app/lib/auth-fetch'
import { WhyPanel } from '@/components/WhyPanel'
import type { FactorScores } from '@/components/FactorBars'

// Signals tab — per-symbol signal history (research-trading-os Task 25 §E/§F). The whole-market
// cross-sectional feed lives in MarketSignalsTab (the no-symbol landing renders it for the
// /signals stub); THIS tab is the audit trail for ONE name: every signal it has emitted,
// newest-first, ALL lifecycles (incl. failed/cancelled), each with a WhyPanel — the factor gates
// read AS-OF that signal's own timestamp.
//
// Async SERVER component: it owns the authedFetch calls and SSR-seeds each WhyPanel with the
// as-of scores so the tab paints fully populated on first byte (no per-card client round-trip).
// PROP CONTRACT (stable; see the T23 scaffold): exactly `{ symbol }` — the in-universe ticker,
// guaranteed non-empty by page.tsx.

// Mirror of @trader/shared-types SignalLifecycle (numeric enum on the wire — the by-ticker
// endpoint serialises the TradeSignal entity to JSON). Kept local because importing the service
// package into the Next page tree pulls server-only deps. Same pattern as /signals/[id].
const LIFECYCLE_LABEL = ['Pending', 'Approved', 'Queued', 'Executing', 'Executed', 'Closed', 'Failed', 'Cancelled']

// Lifecycle → chip tone. Executed/Closed read green (it happened), Failed/Cancelled red, the
// in-flight states amber, Pending neutral.
function lifecycleTone(lc: number | undefined): string {
  switch (lc) {
    case 4: // Executed
    case 5: // Closed
      return 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
    case 6: // Failed
    case 7: // Cancelled
      return 'border-red-900 bg-red-950/40 text-red-300'
    case 1: // Approved
    case 2: // Queued
    case 3: // Executing
      return 'border-amber-900 bg-amber-950/40 text-amber-300'
    default:
      return 'border-gray-800 bg-gray-900 text-gray-400'
  }
}

// Subset of the by-ticker signal shape this tab renders (epoch-ms timestamps, numeric lifecycle).
interface SignalRow {
  id: string
  timestamp: number
  ticker: string
  strategy_id: string
  action: 'BUY' | 'SELL' | 'HOLD'
  confidence: number
  targetWeight: number
  rationale: string
  lifecycle?: number
  entryPrice?: number
  exitPrice?: number
  failureReason?: number
  failureDetail?: string
}

// Cap the number of newest signals we SSR a WhyPanel for. Each WhyPanel needs one as-of scores
// fetch, so this bounds the per-render fan-out; older signals beyond the cap still list and seed
// their WhyPanel lazily (it self-fetches on mount — the FactorBars dual-mode contract).
const SEED_WHY_COUNT = 20

async function fetchSignals(symbol: string): Promise<SignalRow[]> {
  try {
    const r = await authedFetch(`/admin/api/signals/by-ticker/${encodeURIComponent(symbol)}?limit=50`)
    if (!r.ok) return []
    const body = (await r.json().catch(() => ({}))) as { signals?: SignalRow[] }
    return body.signals ?? []
  } catch {
    return []
  }
}

// As-of factor scores for one signal's emission instant — the seed for its WhyPanel. Degrades to
// `{}` (the honest empty state the panel renders as "no gate snapshot"), never throws into the tab.
async function fetchScoresAsOf(symbol: string, asOf: number): Promise<FactorScores> {
  try {
    const r = await authedFetch(
      `/admin/api/strategy/scores?ticker=${encodeURIComponent(symbol)}&asOf=${encodeURIComponent(String(asOf))}`,
    )
    if (!r.ok) return {}
    return ((await r.json().catch(() => ({}))) as FactorScores) ?? {}
  } catch {
    return {}
  }
}

/** Best-effort parse of the rationale JSON string (old signals may store plain text). */
function plainEnglish(rationale: string): string | null {
  try {
    const parsed = JSON.parse(rationale) as { plain_english?: string }
    return typeof parsed.plain_english === 'string' ? parsed.plain_english : null
  } catch {
    return rationale.trim() ? rationale : null
  }
}

export async function SignalsTab({ symbol }: { symbol: string }) {
  const signals = await fetchSignals(symbol)

  // SSR-seed the WhyPanel for the newest SEED_WHY_COUNT signals, fetching their as-of scores in
  // parallel (the as-of read is point-in-time per signal — each uses its OWN timestamp). Keyed by
  // signal id so the seed lookup survives any later re-sort.
  const seedTargets = signals.slice(0, SEED_WHY_COUNT)
  const seeds = await Promise.all(seedTargets.map((s) => fetchScoresAsOf(symbol, s.timestamp)))
  const seedById = new Map<string, FactorScores>(seedTargets.map((s, i) => [s.id, seeds[i]!]))

  if (signals.length === 0) {
    return (
      <div className="rounded border border-gray-800 bg-gray-900/40 p-6">
        <h2 className="text-sm font-medium text-gray-300">
          Signals · <span className="font-mono text-gray-400">{symbol}</span>
        </h2>
        <p className="mt-2 text-sm text-gray-500">
          No signals emitted for this symbol yet. When a strategy cycle ranks{' '}
          <span className="font-mono text-gray-400">{symbol}</span> into a trade, it appears here — newest
          first, with a Why? panel of the factor gates it cleared.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-400">
        Every signal <span className="font-mono text-gray-300">{symbol}</span> has emitted, newest first —
        executed, closed, and failed/cancelled (the full audit trail, not just the tradeable ones). Each
        card&apos;s Why? panel shows the factor gates read <em>as-of that signal&apos;s emission</em>.
      </p>
      {signals.map((s) => {
        const plain = plainEnglish(s.rationale)
        const lc = s.lifecycle
        const failed = lc === 6 || lc === 7
        return (
          <div key={s.id} className="rounded-lg border border-gray-800 bg-gray-950 p-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`text-sm font-semibold ${
                      s.action === 'BUY'
                        ? 'text-emerald-400'
                        : s.action === 'SELL'
                          ? 'text-red-400'
                          : 'text-gray-300'
                    }`}
                  >
                    {s.action}
                  </span>
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${lifecycleTone(lc)}`}
                  >
                    {lc !== undefined ? (LIFECYCLE_LABEL[lc] ?? `lifecycle ${lc}`) : 'unknown'}
                  </span>
                  <span className="font-mono text-xs text-gray-500">{s.strategy_id}</span>
                  <span
                    className="ml-auto font-mono text-xs text-gray-500"
                    title={new Date(s.timestamp).toISOString()}
                  >
                    {new Date(s.timestamp).toISOString().slice(0, 16).replace('T', ' ')}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
                  <span>conf {(s.confidence * 100).toFixed(0)}%</span>
                  <span>target wt {(s.targetWeight * 100).toFixed(1)}%</span>
                  {typeof s.entryPrice === 'number' && <span>entry {s.entryPrice}</span>}
                  {typeof s.exitPrice === 'number' && <span>exit {s.exitPrice}</span>}
                </div>
                {plain && <p className="text-sm text-gray-300">{plain}</p>}
                {failed && s.failureDetail && <p className="text-xs text-red-300">Failed: {s.failureDetail}</p>}
                <a
                  href={`/signals/${encodeURIComponent(s.id)}`}
                  className="inline-block text-xs text-sky-400 hover:underline"
                >
                  Full analysis →
                </a>
              </div>
              <WhyPanel
                symbol={symbol}
                asOf={s.timestamp}
                action={s.action}
                confidence={s.confidence}
                initial={seedById.get(s.id) ?? null}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
