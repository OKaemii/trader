'use client'
import type { ValidationReportV2 } from './validation-types'
import { quasiPLabel } from './validation-types'
import { InSamplePanel } from './InSamplePanel'
import { MCPTHistogramPanel } from './MCPTHistogramPanel'
import { WalkForwardPanel } from './WalkForwardPanel'

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="font-mono text-sm text-gray-200">{value}</div>
    </div>
  )
}

export function ValidationReportView({ report }: { report: ValidationReportV2 }) {
  const lg = report.legacy_gates ?? ({} as ValidationReportV2['legacy_gates'])
  return (
    <div className="space-y-4">
      <div className="rounded border border-gray-800 bg-gray-950 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-gray-200">{report.strategy_id}</span>
          <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
            report.passed ? 'bg-emerald-700 text-white' : 'bg-red-700 text-white'
          }`}>{report.passed ? 'PASS' : 'FAIL'}</span>
          <span className="rounded bg-gray-700 px-2 py-0.5 text-[10px] font-semibold uppercase text-gray-200">MCPT</span>
          <span className="ml-auto text-[11px] text-gray-500">
            {report.universe_size_at_run} names · {report.objective_name} · {report.rebalance_days}d rebalance
          </span>
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-x-4 gap-y-1 md:grid-cols-6">
          <Stat label="IS-MCPT p" value={quasiPLabel(report.step2_in_sample_mcpt)} />
          <Stat label="WF-MCPT p" value={quasiPLabel(report.step4_walk_forward_mcpt)} />
          <Stat label="OOS Sharpe" value={lg.oos_sharpe?.toFixed(2) ?? '—'} />
          <Stat label="Mean IC" value={lg.mean_ic?.toFixed(4) ?? '—'} />
          <Stat label="DSR" value={lg.deflated_sharpe?.toFixed(3) ?? '—'} />
          <Stat label="Max DD" value={lg.max_drawdown !== undefined ? `${(lg.max_drawdown * 100).toFixed(1)}%` : '—'} />
        </dl>
        {report.failures?.length > 0 && (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Gate failures</div>
            <ul className="ml-4 list-disc text-[11px] text-red-300">
              {report.failures.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </div>
        )}
        {report.data_quality && <div className="mt-2 text-[10px] text-gray-600">{report.data_quality}</div>}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <InSamplePanel step={report.step1_in_sample_fit} objectiveName={report.objective_name} />
        <MCPTHistogramPanel step={report.step2_in_sample_mcpt} title="Step 2 · In-sample MCPT" objectiveName={report.objective_name} />
        <WalkForwardPanel step={report.step3_walk_forward} overlays={report.benchmark_overlays ?? []} objectiveName={report.objective_name} />
        <MCPTHistogramPanel step={report.step4_walk_forward_mcpt} title="Step 4 · Walk-forward MCPT" objectiveName={report.objective_name} />
      </div>

      {report.context_notes?.length > 0 && (
        <div className="rounded border border-gray-800 bg-gray-900 p-3 text-[10px] text-gray-500">
          {report.context_notes.map((n, i) => <div key={i}>· {n}</div>)}
        </div>
      )}
    </div>
  )
}
