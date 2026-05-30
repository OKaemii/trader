'use client'
import { useEffect, useState } from 'react'
import { ValidationRunner } from './ValidationRunner'
import { ValidationJobsTable } from './ValidationJobsTable'
import { ValidationReportView } from './ValidationReportView'
import type { ValidationJob } from './validation-types'

// Orchestrates the MCPT validation workflow: submit → jobs table (poll) → selected report.
// The selected job is polled every 8s until terminal, then the four-panel report renders. This
// is the Phase-5 backend made legible (the validator runs hours in the background; nothing here
// blocks). Stale detail from a prior selection is filtered at render via the id guard rather
// than cleared synchronously in the effect.
export function ValidationView() {
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ValidationJob | null>(null)

  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    let done = false
    const tick = async () => {
      if (done) return
      try {
        const r = await fetch(`/portal-api/admin/validator/jobs/${selectedId}`)
        const d = (await r.json()) as ValidationJob
        if (cancelled) return
        setDetail(d)
        if (d.status === 'completed' || d.status === 'failed') done = true
      } catch {
        /* transient blip — keep polling */
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 8000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [selectedId])

  const shown = detail?._id === selectedId ? detail : null

  return (
    <div className="space-y-6">
      <ValidationRunner onSubmitted={(id) => { setRefreshKey((k) => k + 1); setSelectedId(id) }} />
      <ValidationJobsTable refreshKey={refreshKey} selectedId={selectedId} onSelect={setSelectedId} />
      {selectedId && (
        shown?.status === 'completed' && shown.report ? (
          <ValidationReportView report={shown.report} />
        ) : shown?.status === 'failed' ? (
          <div className="rounded border border-red-900 bg-gray-900 p-4 text-xs text-red-300">
            Job failed: {shown.error ?? 'unknown error'}
          </div>
        ) : (
          <div className="rounded border border-gray-800 bg-gray-900 p-4 text-xs text-gray-400">
            Job {shown?.status ?? 'loading'}… runs in the background; this view refreshes when it completes.
          </div>
        )
      )}
    </div>
  )
}
