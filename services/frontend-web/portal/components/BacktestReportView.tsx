'use client'
import type { BacktestReport } from './validation-types'
import { Explain } from '@/components/Explain'

// Completed walk-forward backtest report (extracted from the old inline BacktestRunner result).
function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

// `explain` threads a learning-layer toggletip onto the stat label: pass the registry id +
// the raw value the band selector expects (Sharpe as-is; DSR/PBO as a 0–1 fraction).
function Stat({ label, value, explain }: { label: string; value: string; explain?: { id: string; value: number } }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-gray-500">
        {label}
        {explain && <Explain id={explain.id} value={explain.value} />}
      </div>
      <div className="font-mono text-sm text-gray-200">{value}</div>
    </div>
  )
}

export function BacktestReportView({ report }: { report: BacktestReport }) {
  const bm = report.benchmark ?? null
  return (
    <div className="rounded border border-gray-800 bg-gray-950 p-4 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-gray-200">{report.strategy_id}</span>
        <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
          report.passed ? 'bg-emerald-700 text-white' : 'bg-red-700 text-white'
        }`}>{report.passed ? 'PASS' : 'FAIL'}</span>
        <span className="rounded bg-gray-700 px-2 py-0.5 text-[10px] font-semibold uppercase text-gray-200">replay</span>
        {report.completed_at && <span className="ml-auto font-mono text-gray-500">{report.completed_at}</span>}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-5">
        <Stat label="OOS Sharpe" value={report.oos_sharpe.toFixed(3)} explain={{ id: 'sharpe', value: report.oos_sharpe }} />
        <Stat label="Mean IC" value={report.mean_ic.toFixed(4)} />
        <Stat label="Deflated SR" value={report.deflated_sharpe.toFixed(3)} explain={{ id: 'dsr', value: report.deflated_sharpe }} />
        <Stat label="PBO" value={report.pbo.toFixed(3)} explain={{ id: 'pbo', value: report.pbo }} />
        <Stat label="FDR p-value" value={report.fdr_corrected_pvalue.toFixed(4)} />
      </dl>

      {bm && (
        <div className="mt-3 rounded border border-gray-800 bg-gray-900 p-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-gray-500">vs {bm.benchmark}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
              bm.beats_market ? 'bg-emerald-700 text-white' : 'bg-amber-700 text-white'
            }`}>{bm.beats_market ? 'beats market' : 'trails market'}</span>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-5">
            <Stat label="Strategy ret" value={pct(bm.strategy_total_return)} />
            <Stat label="Benchmark ret" value={pct(bm.benchmark_total_return)} />
            <Stat label="Excess" value={pct(bm.excess_total_return)} />
            <Stat label="Alpha (ann)" value={pct(bm.alpha_annual)} />
            <Stat label="Beta / IR" value={`${bm.beta.toFixed(2)} / ${bm.information_ratio.toFixed(2)}`} />
          </dl>
        </div>
      )}

      {report.failures.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Failures</div>
          <ul className="ml-4 list-disc text-red-300">
            {report.failures.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </div>
      )}
      <div className="mt-2 text-[10px] text-gray-500">
        Ablations tested: {report.ablation_variants_tested?.join(', ') || '—'}
      </div>
      {report.data_source && <div className="mt-1 text-[10px] text-gray-600">{report.data_source}</div>}
    </div>
  )
}
