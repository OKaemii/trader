'use client'
import { useCallback, useEffect, useState } from 'react'
import type { JobStatus, ValidationJob } from './validation-types'
import { etaLabel } from './validation-types'

const STATUS_CLASS: Record<JobStatus, string> = {
  queued: 'bg-gray-700 text-gray-200',
  running: 'bg-amber-700 text-white',
  completed: 'bg-emerald-700 text-white',
  failed: 'bg-red-700 text-white',
  cancelled: 'bg-gray-600 text-gray-300',
}

function ts(s?: string): string {
  return s ? new Date(s).toLocaleString() : '—'
}

function yr(ms: unknown): string | number {
  return typeof ms === 'number' ? new Date(ms).getUTCFullYear() : '?'
}

function summarizeReq(job: ValidationJob): string {
  const r = job.request ?? {}
  const seed = `seed ${job.seed ?? 0}`
  if (job.kind === 'backtest') {
    return `${yr(r.data_start_ms)}→${yr(r.data_end_ms)} · ${(r.benchmark as string) ?? '^GSPC'} · ${seed}`
  }
  return `${yr(r.start_ms)}→${yr(r.end_ms)} · ${(r.objective_name as string) ?? 'profit_factor'}` +
    ` · ${(r.mcpt_n_in_sample as number) ?? '?'}/${(r.mcpt_n_wf as number) ?? '?'} · ${seed}`
}

export function ValidationJobsTable({
  refreshKey, selectedId, onSelect, onClone,
}: {
  refreshKey: number
  selectedId: string | null
  onSelect: (id: string) => void
  onClone: (job: ValidationJob) => void
}) {
  const [jobs, setJobs] = useState<ValidationJob[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/portal-api/admin/validator/jobs?limit=20')
      const d = await r.json()
      if (!r.ok) throw new Error(`status ${r.status}`)
      setJobs(d.jobs ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed')
    }
  }, [])

  // Poll faster while any job is running (responsive progress/ETA), slower when idle.
  const anyRunning = jobs.some((j) => j.status === 'running')
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), anyRunning ? 5000 : 10000)
    return () => clearInterval(t)
  }, [load, refreshKey, anyRunning])

  async function cancel(job: ValidationJob) {
    if (!window.confirm(`Cancel ${job.kind ?? 'mcpt'} job for ${job.strategy_id}? A running job stops at the next loop boundary; a queued one is dropped.`)) return
    try {
      await fetch(`/portal-api/admin/validator/jobs/${job._id}/cancel`, { method: 'POST' })
    } finally {
      void load()
    }
  }

  function StatusCell({ job }: { job: ValidationJob }) {
    if (job.status === 'running' && job.progress) {
      return (
        <span className="text-[11px] text-amber-300">
          {Math.round(job.progress.pct * 100)}% · {job.progress.stage} · {etaLabel(job.progress.eta_ms)}
        </span>
      )
    }
    if (job.status === 'completed' && job.summary) {
      return (
        <span className="inline-flex items-center gap-1">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${job.summary.passed ? 'bg-emerald-700 text-white' : 'bg-red-700 text-white'}`}>
            {job.summary.passed ? 'PASS' : 'FAIL'}
          </span>
          {job.summary.early_stopped && (
            <span className="text-[10px] text-gray-500">stopped {job.summary.n_done}/{job.summary.n_planned}</span>
          )}
        </span>
      )
    }
    return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${STATUS_CLASS[job.status] ?? 'bg-gray-700 text-gray-200'}`}>{job.status}</span>
  }

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">Jobs</h2>
        <button type="button" onClick={() => void load()} className="text-xs text-gray-400 hover:text-gray-200">Refresh</button>
      </div>
      {error ? (
        <p className="text-xs text-red-400">{error}</p>
      ) : jobs.length === 0 ? (
        <p className="text-xs text-gray-500">No jobs yet — queue a backtest or validation above.</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-gray-500">
            <tr className="border-b border-gray-800">
              <th className="py-1 text-left font-normal">Created</th>
              <th className="py-1 text-left font-normal">Kind</th>
              <th className="py-1 text-left font-normal">Strategy</th>
              <th className="py-1 text-left font-normal">Params</th>
              <th className="py-1 text-left font-normal">Status</th>
              <th className="py-1 text-right font-normal">Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const terminal = j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled'
              return (
                <tr
                  key={j._id}
                  onClick={() => onSelect(j._id)}
                  className={`cursor-pointer border-b border-gray-800/50 hover:bg-gray-800/40 ${selectedId === j._id ? 'bg-gray-800/60' : ''}`}
                >
                  <td className="py-1.5 font-mono text-gray-400">{ts(j.createdAt)}</td>
                  <td className="py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${j.kind === 'backtest' ? 'bg-sky-800 text-sky-200' : 'bg-violet-800 text-violet-200'}`}>{j.kind ?? 'mcpt'}</span>
                  </td>
                  <td className="py-1.5 text-gray-300">{j.strategy_id}</td>
                  <td className="py-1.5 font-mono text-[11px] text-gray-500">{summarizeReq(j)}</td>
                  <td className="py-1.5"><StatusCell job={j} /></td>
                  <td className="py-1.5 text-right">
                    <button type="button" onClick={(e) => { e.stopPropagation(); onClone(j) }}
                      className="mr-2 text-[11px] text-gray-400 hover:text-gray-200">Clone</button>
                    {!terminal && (
                      <button type="button" onClick={(e) => { e.stopPropagation(); void cancel(j) }}
                        className="text-[11px] text-red-400 hover:text-red-300">Cancel</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
