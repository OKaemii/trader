'use client'
import { useEffect, useState } from 'react'
import { BacktestRunner } from './BacktestRunner'
import { ValidationRunner } from './ValidationRunner'
import { ValidationJobsTable } from './ValidationJobsTable'
import { ValidationReportView } from './ValidationReportView'
import { BacktestReportView } from './BacktestReportView'
import { JobProgressBar } from './JobProgressBar'
import { JobParamsPanel } from './JobParamsPanel'
import { ValidationReports } from './ValidationReports'
import type { BacktestReport, JobKind, ValidationJob, ValidationReportV2 } from './validation-types'

interface ResearchViewProps {
  // SSR-seeded historical results so the table renders on first paint.
  initialReports?: Array<Record<string, unknown>> | null
}

// One queued-jobs experience for both kinds: two submit forms → one jobs table → a selected-job
// detail (params + progress/report by kind) → the historical results table. The selected id is
// mirrored to ?job=<id> so a refresh / shared link reopens the run; with no ?job and a job running,
// it auto-selects that one.
export function ResearchView({ initialReports = null }: ResearchViewProps = {}) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ValidationJob | null>(null)
  const [clone, setClone] = useState<{ kind: JobKind; req: Record<string, unknown> } | null>(null)

  // Mount: restore ?job=, else auto-select a running job if one exists.
  useEffect(() => {
    const j = new URL(window.location.href).searchParams.get('job')
    if (j) { setSelectedId(j); return }
    void (async () => {
      try {
        const r = await fetch('/portal-api/admin/validator/jobs?limit=20')
        const d = await r.json()
        const running = (d.jobs ?? []).find((x: ValidationJob) => x.status === 'running')
        if (running) setSelectedId(running._id)
      } catch { /* ignore */ }
    })()
  }, [])

  // Mirror the selection to the URL (deep-link / refresh-survival).
  useEffect(() => {
    const u = new URL(window.location.href)
    if (selectedId) u.searchParams.set('job', selectedId)
    else u.searchParams.delete('job')
    window.history.replaceState(null, '', u.toString())
  }, [selectedId])

  // Poll the selected job every 5s until terminal.
  useEffect(() => {
    if (!selectedId) { setDetail(null); return }
    let cancelled = false
    let done = false
    const tick = async () => {
      if (done) return
      try {
        const r = await fetch(`/portal-api/admin/validator/jobs/${selectedId}`)
        const d = (await r.json()) as ValidationJob
        if (cancelled) return
        setDetail(d)
        if (d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled') done = true
      } catch { /* transient — keep polling */ }
    }
    void tick()
    const timer = setInterval(() => void tick(), 5000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [selectedId])

  function onSubmitted(id: string) {
    setClone(null)
    setRefreshKey((k) => k + 1)
    setSelectedId(id)
  }

  function onClone(job: ValidationJob) {
    setClone({ kind: job.kind ?? 'mcpt', req: { ...(job.request ?? {}) } })
  }

  const shown = detail?._id === selectedId ? detail : null

  return (
    <div className="space-y-6">
      <BacktestRunner onSubmitted={onSubmitted} initial={clone?.kind === 'backtest' ? clone.req : null} />
      <ValidationRunner onSubmitted={onSubmitted} initial={clone && clone.kind !== 'backtest' ? clone.req : null} />

      <ValidationJobsTable refreshKey={refreshKey} selectedId={selectedId} onSelect={setSelectedId} onClone={onClone} />

      {selectedId && shown && (
        <div className="space-y-3">
          <JobParamsPanel kind={shown.kind} seed={shown.seed} request={shown.request} />
          {shown.status === 'running' || shown.status === 'queued' ? (
            <JobProgressBar kind={shown.kind} progress={shown.progress} />
          ) : shown.status === 'failed' ? (
            <div className="rounded border border-red-900 bg-gray-900 p-4 text-xs text-red-300">
              Job failed: {shown.error ?? 'unknown error'}
            </div>
          ) : shown.status === 'cancelled' ? (
            <div className="rounded border border-gray-800 bg-gray-900 p-4 text-xs text-gray-400">
              Job cancelled before completion.
            </div>
          ) : shown.report ? (
            shown.kind === 'backtest'
              ? <BacktestReportView report={shown.report as BacktestReport} />
              : <ValidationReportView report={shown.report as ValidationReportV2} />
          ) : null}
        </div>
      )}

      <ValidationReports refreshKey={refreshKey} initial={initialReports as never} />
    </div>
  )
}
