'use client'
import type { JobKind } from './validation-types'

// The parameters a job was launched with — rendered for any selected job regardless of status, so
// "the entered parameters" (and the seed) are visible the instant it's queued.
const HIDE = new Set(['internal_token'])

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (Array.isArray(v)) return v.length ? `${v.length} item${v.length > 1 ? 's' : ''}` : 'default'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  return String(v)
}

export function JobParamsPanel({
  kind, seed, request,
}: { kind?: JobKind; seed?: number; request?: Record<string, unknown> }) {
  const entries = Object.entries(request ?? {}).filter(([k]) => !HIDE.has(k))
  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-gray-500">Parameters</span>
        <span className="rounded bg-gray-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-gray-200">{kind ?? 'mcpt'}</span>
        <span className="font-mono text-[11px] text-gray-400">seed {seed ?? 0}</span>
      </div>
      {entries.length === 0 ? (
        <p className="text-[11px] text-gray-500">No parameters recorded.</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-3">
          {entries.map(([k, v]) => (
            <div key={k}>
              <dt className="text-[10px] uppercase tracking-wide text-gray-600">{k}</dt>
              <dd className="font-mono text-xs text-gray-300">{fmt(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
