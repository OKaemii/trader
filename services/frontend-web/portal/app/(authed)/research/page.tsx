import { ResearchView } from '@/components/ResearchView'
import { ValidationView } from '@/components/ValidationView'
import { FeatureAuditPanel } from '@/components/FeatureAuditPanel'
import { authedFetch } from '@/app/lib/auth-fetch'

// SSR-seed the validation-reports table so it renders 10 rows on first paint instead of
// waiting for client hydration + a backtest results round-trip.
async function fetchInitialReports(): Promise<Array<Record<string, unknown>> | null> {
  try {
    const r = await authedFetch('/admin/api/backtest/results?limit=10')
    if (!r.ok) return null
    const d = (await r.json()) as { results?: Array<Record<string, unknown>> }
    return d.results ?? []
  } catch {
    return null
  }
}

export default async function ResearchPage() {
  const initialReports = await fetchInitialReports()
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Research & Investigation</h1>
        <p className="mt-1 text-sm text-gray-400">
          Run walk-forward backtests and permutation-tested (MCPT) validations, review reports,
          and inspect factor decomposition. Results persist to MongoDB and <span className="text-gray-300">inform</span>{' '}
          the live-trading decision — they do not auto-open it. The gate is a separate manual
          step (the <code className="text-gray-300">trading:live_approved</code> Redis flag).
        </p>
      </div>

      <ResearchView initialReports={initialReports} />

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Permutation validation (MCPT)</h2>
          <p className="mt-1 text-xs text-gray-400">
            The strongest gate: does the strategy beat what the same fitting process produces on
            signal-free permutations of the market? Runs as a background job (minutes–hours).
          </p>
        </div>
        <ValidationView />
      </section>

      <FeatureAuditPanel />

      <section className="rounded border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-2 text-sm font-medium text-gray-300">
          Factor decomposition <span className="ml-2 rounded bg-amber-700 px-1.5 py-0.5 text-[10px] uppercase text-white">CLI only</span>
        </h2>
        <p className="text-xs text-gray-400">
          The Fama-MacBeth factor decomposition runs as a standalone Python script against the
          signals collection. Required gate: residual alpha &gt; 0 and p &lt; 0.10. Paste the result
          into <code className="text-gray-300">agent-docs/research/tda-economic-rationale.md</code>
          {' '}§4 before enabling <code className="text-gray-300">topology_v1</code>.
        </p>
        <pre className="mt-3 overflow-x-auto rounded bg-gray-950 p-3 text-[11px] leading-relaxed text-gray-300">
{`# from services/strategy-engine
MONGODB_URL=mongodb://trader:password@192.168.50.2:27017/trader \\
  python -m src.analysis.factor_decomposition \\
    --strategy topology_v1 --horizon 5`}
        </pre>
        <pre className="mt-4 overflow-x-auto rounded border border-gray-800 bg-gray-950 p-3 font-mono text-[11px] leading-relaxed text-gray-400">
{`Strategy: topology_v1
Period: [START] to [END] (walk-forward OOS only)
Universe: [N instruments]

Factor Attribution:
  Momentum (12-1 month):   β = ____, t = ____
  Low Volatility:          β = ____, t = ____
  Liquidity (Amihud):      β = ____, t = ____
  Size (log market cap):   β = ____, t = ____
  ──────────────────────────────────────────────
  Residual alpha (annual): ____ %
  Residual t-stat:         ____
  Residual p-value:        ____

Conclusion: [ ] PASS — residual alpha positive and p < 0.10
            [ ] FAIL — residual not distinguishable from zero`}
        </pre>
        <p className="mt-3 text-[11px] text-gray-500">
          Server-side runner endpoint not yet implemented — the script needs an HTTP wrapper and async
          job queue before it can fire from the portal. Tracked separately.
        </p>
      </section>
    </div>
  )
}
