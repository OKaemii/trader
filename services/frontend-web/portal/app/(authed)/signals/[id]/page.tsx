import Link from 'next/link'
import { authedFetch } from '@/app/lib/auth-fetch'
import { Backlinks } from '@/components/Backlinks'
import { fetchBacklinks } from '@/app/lib/research-notes'

// IA-redesign Task 14. The signals LIST lives in the Research workspace (Signals tab,
// see app/(authed)/signals/page.tsx → redirect stub); THIS is the per-signal detail page
// — a real route, the target of the notification-service "View full analysis →" email
// link (/signals/:id). SSR-seeds GET /admin/api/signals/:id (signal-service reads its own
// Mongo collection — no cross-service hop) and renders analysis / lifecycle / fills.

// Mirror of @trader/shared-types SignalLifecycle. Kept local because importing the service
// package into the Next.js page tree pulls server-only deps. The numeric values match the
// enum order — change here if the enum order ever changes. (Same pattern as the trips page.)
const LIFECYCLE_LABEL = ['Pending', 'Approved', 'Queued', 'Executing', 'Executed', 'Closed', 'Failed', 'Cancelled']

// Mirror of @trader/shared-types SignalFailureReason (numeric enum on the wire).
const FAILURE_LABEL = [
  'Cash insufficient',
  'Market drift',
  'Queue expired',
  'Broker rejected',
  'Retries exhausted',
  'Zero quantity',
  'Manual cancel',
  'Auto-cancelled (circuit breaker)',
]

// Shape of the signal-service GET /admin/api/signals/:id response (the TradeSignal entity
// serialized to JSON: timestamps are epoch-ms numbers, rationale is a JSON string,
// lifecycle/failureReason are numeric enums). Only the fields this page renders are typed.
interface FeaturesSnapshot {
  strategy_id?: string
  regime_confidence?: number
  position_size_multiplier?: number
  composite_scores?: Record<string, number>
  factor_attributions?: Record<string, Record<string, number>>
  sectors?: Record<string, string>
}

interface SignalDoc {
  id: string
  timestamp: number
  ticker: string
  strategy_id: string
  action: 'BUY' | 'SELL' | 'HOLD'
  confidence: number
  targetWeight: number
  rationale: string
  approved?: boolean
  lifecycle?: number
  entryPrice?: number
  exitPrice?: number
  executedQuantity?: number
  attempts?: number
  approvedAt?: number
  queuedAt?: number
  executedAt?: number
  closedAt?: number
  lastAttemptAt?: number
  failureReason?: number
  failureDetail?: string
  pieId?: string
  features_snapshot?: FeaturesSnapshot
}

// Parsed shape of the rationale JSON string (best-effort — old signals may store plain text).
interface Rationale {
  plain_english?: string
  economic_mechanism?: string
  factor_exposures?: Record<string, number>
  residual_alpha?: number
  topology_contribution?: string
  uncertainty?: 'high' | 'medium' | 'low'
}

async function fetchSignal(id: string): Promise<SignalDoc | null> {
  try {
    const r = await authedFetch(`/admin/api/signals/${encodeURIComponent(id)}`)
    if (!r.ok) return null
    return (await r.json()) as SignalDoc
  } catch {
    return null
  }
}

function fmtTs(v: number | undefined): string {
  if (v === undefined || v === null) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

function lifecycleLabel(lc: number | undefined): string {
  if (lc === undefined || lc === null) return '—'
  return LIFECYCLE_LABEL[lc] ?? `#${lc}`
}

const lifecycleAccent: Record<number, string> = {
  4: 'amber', // Executed
  5: 'gray',  // Closed
  6: 'red',   // Failed
  7: 'red',   // Cancelled
}

export default async function SignalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // Signal + the research notes that @-mention this signal (T34 §G backlinks) — independent reads.
  const [signal, backlinks] = await Promise.all([fetchSignal(id), fetchBacklinks('signal', id)])

  if (!signal) {
    return (
      <div className="p-6">
        <Link href="/research?tab=signals" className="text-xs text-gray-400 underline hover:text-gray-200">← back to signals</Link>
        <h1 className="mt-3 text-xl font-bold text-white">Signal not found</h1>
        <p className="mt-1 text-sm text-gray-400">No signal exists for id <code className="font-mono">{id}</code>.</p>
      </div>
    )
  }

  const rationale: Rationale | null = (() => {
    try {
      const parsed = JSON.parse(signal.rationale)
      return parsed && typeof parsed === 'object' ? (parsed as Rationale) : null
    } catch {
      return null
    }
  })()

  const fs = signal.features_snapshot
  // factor_exposures: prefer the rationale's, fall back to the per-ticker slice of the
  // features snapshot (factor_attributions[ticker]).
  const factorExposures: Record<string, number> | undefined =
    rationale?.factor_exposures ?? fs?.factor_attributions?.[signal.ticker]
  const compositeScore = fs?.composite_scores?.[signal.ticker]
  const sector = fs?.sectors?.[signal.ticker]

  // Lifecycle timeline — only render steps that actually have a timestamp.
  const timeline: Array<{ label: string; ts: number | undefined }> = [
    { label: 'Emitted', ts: signal.timestamp },
    { label: 'Approved', ts: signal.approvedAt },
    { label: 'Queued', ts: signal.queuedAt },
    { label: 'Executed', ts: signal.executedAt },
    { label: 'Closed', ts: signal.closedAt },
  ].filter((s) => s.ts !== undefined)

  const isFailed = signal.lifecycle === 6 || signal.lifecycle === 7

  return (
    <div className="space-y-6 p-6">
      <div>
        <Link href="/research?tab=signals" className="text-xs text-gray-400 underline hover:text-gray-200">← back to signals</Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-white">{signal.ticker}</h1>
          <span className={`rounded px-2 py-0.5 text-xs font-semibold text-white ${signal.action === 'BUY' ? 'bg-green-600' : signal.action === 'SELL' ? 'bg-red-600' : 'bg-gray-600'}`}>
            {signal.action}
          </span>
          <span className={`rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
            signal.lifecycle === 6 || signal.lifecycle === 7 ? 'bg-red-700 text-white'
              : signal.lifecycle === 4 ? 'bg-amber-600 text-white'
              : signal.lifecycle === 5 ? 'bg-slate-600 text-gray-200'
              : 'bg-indigo-700 text-white'
          }`}>
            {lifecycleLabel(signal.lifecycle)}
          </span>
        </div>
        <p className="mt-1 font-mono text-xs text-gray-500">{signal.id}</p>
      </div>

      {isFailed && (signal.failureReason !== undefined || signal.failureDetail) && (
        <div className="rounded border border-red-900 bg-red-950/40 p-3 text-sm">
          <span className="font-semibold text-red-300">
            {signal.failureReason !== undefined ? (FAILURE_LABEL[signal.failureReason] ?? `Failure #${signal.failureReason}`) : 'Failed'}
          </span>
          {signal.failureDetail && <span className="text-red-200"> — {signal.failureDetail}</span>}
        </div>
      )}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
        <Fact label="Strategy" value={signal.strategy_id} />
        <Fact label="Lifecycle" value={lifecycleLabel(signal.lifecycle)} accent={lifecycleAccent[signal.lifecycle ?? -1] as 'amber' | 'red' | 'gray' | undefined} />
        <Fact label="Confidence" value={`${(signal.confidence * 100).toFixed(0)}%`} />
        <Fact label="Target weight" value={`${(signal.targetWeight * 100).toFixed(2)}%`} />
        <Fact label="Emitted (UTC)" value={fmtTs(signal.timestamp)} />
        {sector && <Fact label="Sector" value={sector} />}
        {compositeScore !== undefined && <Fact label="Composite score" value={compositeScore.toFixed(4)} />}
        {fs?.regime_confidence !== undefined && <Fact label="Regime confidence" value={`${(fs.regime_confidence * 100).toFixed(0)}%`} />}
        {fs?.position_size_multiplier !== undefined && <Fact label="Size multiplier" value={fs.position_size_multiplier.toFixed(2)} />}
        {signal.pieId && <Fact label="Pie" value={signal.pieId} />}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-300">Analysis</h2>
        <div className="space-y-3 rounded border border-gray-800 bg-gray-950 p-4 text-sm">
          <p className="text-gray-200">{rationale?.plain_english ?? signal.rationale}</p>
          {rationale?.economic_mechanism && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-gray-500">Economic mechanism</div>
              <p className="mt-0.5 text-gray-300">{rationale.economic_mechanism}</p>
            </div>
          )}
          {rationale?.topology_contribution && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-gray-500">Topology contribution</div>
              <p className="mt-0.5 text-gray-300">{rationale.topology_contribution}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-400">
            {rationale?.uncertainty && <span>Uncertainty: <span className="text-gray-200">{rationale.uncertainty}</span></span>}
            {rationale?.residual_alpha !== undefined && <span>Residual alpha: <span className="font-mono text-gray-200">{rationale.residual_alpha.toFixed(4)}</span></span>}
          </div>
        </div>
      </section>

      {factorExposures && Object.keys(factorExposures).length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-gray-300">Factor exposures</h2>
          <div className="overflow-x-auto rounded border border-gray-800">
            <table className="min-w-full divide-y divide-gray-800 text-xs">
              <thead className="bg-gray-900 text-left uppercase tracking-wider text-gray-400">
                <tr>
                  <th className="px-3 py-1.5">Factor</th>
                  <th className="px-3 py-1.5 text-right">Contribution</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800 bg-gray-950 font-mono">
                {Object.entries(factorExposures).map(([factor, value]) => (
                  <tr key={factor} className="text-gray-200">
                    <td className="px-3 py-1.5">{factor}</td>
                    <td className={`px-3 py-1.5 text-right ${value >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {value >= 0 ? '+' : ''}{value.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-300">Fills &amp; execution</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
          <Fact label="Entry price" value={signal.entryPrice !== undefined ? signal.entryPrice.toFixed(2) : '—'} />
          <Fact label="Exit price" value={signal.exitPrice !== undefined ? signal.exitPrice.toFixed(2) : '—'} />
          <Fact label="Executed qty" value={signal.executedQuantity !== undefined ? signal.executedQuantity.toFixed(4) : '—'} />
          <Fact label="Attempts" value={String(signal.attempts ?? 0)} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-300">Lifecycle timeline</h2>
        <div className="overflow-x-auto rounded border border-gray-800">
          <table className="min-w-full divide-y divide-gray-800 text-xs">
            <thead className="bg-gray-900 text-left uppercase tracking-wider text-gray-400">
              <tr>
                <th className="px-3 py-1.5">Step</th>
                <th className="px-3 py-1.5">When (UTC)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800 bg-gray-950 font-mono">
              {timeline.map((step) => (
                <tr key={step.label} className="text-gray-200">
                  <td className="px-3 py-1.5">{step.label}</td>
                  <td className="px-3 py-1.5">{fmtTs(step.ts)}</td>
                </tr>
              ))}
              {signal.lastAttemptAt !== undefined && (
                <tr className="text-gray-400">
                  <td className="px-3 py-1.5">Last attempt</td>
                  <td className="px-3 py-1.5">{fmtTs(signal.lastAttemptAt)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* `id` (the URL param) is the same value the SSR seed above queried, so the client re-fetch
          ref matches the seed exactly. signal.id echoes it. */}
      <Backlinks kind="signal" ref_={id} initial={backlinks} />
    </div>
  )
}

function Fact({ label, value, accent }: { label: string; value: string; accent?: 'amber' | 'red' | 'gray' }) {
  const color = accent === 'red' ? 'text-red-300' : accent === 'amber' ? 'text-amber-300' : 'text-gray-100'
  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-3">
      <div className="text-[11px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`mt-1 break-words font-mono text-sm ${color}`}>{value}</div>
    </div>
  )
}
