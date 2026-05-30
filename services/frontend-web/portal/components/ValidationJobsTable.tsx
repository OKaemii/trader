'use client'
import { useCallback, useEffect, useState } from 'react'
import type { JobStatus, ValidationJob } from './validation-types'

const STATUS_CLASS: Record<JobStatus, string> = {
  queued: 'bg-gray-700 text-gray-200',
  running: 'bg-amber-700 text-white',
  completed: 'bg-emerald-700 text-white',
  failed: 'bg-red-700 text-white',
}

function ts(s?: string): string {
  return s ? new Date(s).toLocaleString() : '—'
}

export function ValidationJobsTable({
  refreshKey, selectedId, onSelect,
}: { refreshKey: number; selectedId: string | null; onSelect: (id: string) => void }) {
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

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 10000)   // jobs run minutes–hours; poll for status
    return () => clearInterval(t)
  }, [load, refreshKey])

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">Validation jobs</h2>
        <button type="button" onClick={() => void load()} className="text-xs text-gray-400 hover:text-gray-200">Refresh</button>
      </div>
      {error ? (
        <p className="text-xs text-red-400">{error}</p>
      ) : jobs.length === 0 ? (
        <p className="text-xs text-gray-500">No validation jobs yet — queue one above.</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-gray-500">
            <tr className="border-b border-gray-800">
              <th className="py-1 text-left font-normal">Created</th>
              <th className="py-1 text-left font-normal">Strategy</th>
              <th className="py-1 text-center font-normal">Status</th>
              <th className="py-1 text-right font-normal" />
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr
                key={j._id}
                onClick={() => onSelect(j._id)}
                className={`cursor-pointer border-b border-gray-800/50 hover:bg-gray-800/40 ${selectedId === j._id ? 'bg-gray-800/60' : ''}`}
              >
                <td className="py-1.5 font-mono text-gray-400">{ts(j.createdAt)}</td>
                <td className="py-1.5 text-gray-300">{j.strategy_id}</td>
                <td className="py-1.5 text-center">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${STATUS_CLASS[j.status] ?? 'bg-gray-700 text-gray-200'}`}>{j.status}</span>
                </td>
                <td className="py-1.5 text-right text-[11px] text-indigo-400">view →</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
