'use client'
import { useEffect, useState } from 'react'
import type { JobKind, JobProgress } from './validation-types'
import { etaLabel, stagesFor } from './validation-types'

// Smoothly count the ETA down between the ~5s server polls: re-anchor whenever the polled progress
// object changes, then tick locally each second from (eta_ms − elapsed-since-the-snapshot). Pure
// client; no extra requests.
function useEtaCountdown(progress?: JobProgress): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!progress || progress.eta_ms == null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [progress])
  if (!progress || progress.eta_ms == null) return '—'
  return etaLabel(progress.eta_ms - (now - progress.updated_at))
}

// A per-kind stage stepper (current phase lit, earlier ones checked, the long pole flagged) + a
// percent bar + a live ETA. The stage keys are the backend `set_stage` labels.
export function JobProgressBar({ kind, progress }: { kind?: JobKind; progress?: JobProgress }) {
  const eta = useEtaCountdown(progress)
  const stages = stagesFor(kind)
  const currentIdx = stages.findIndex((s) => s.key === progress?.stage)
  const pct = progress ? Math.round(progress.pct * 100) : 0
  return (
    <div className="rounded border border-gray-800 bg-gray-950 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {stages.map((s, i) => {
          const done = currentIdx > i
          const active = currentIdx === i
          return (
            <span
              key={s.key}
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                active ? 'bg-amber-600 text-white'
                  : done ? 'bg-emerald-800 text-emerald-200'
                    : 'bg-gray-800 text-gray-500'
              }`}
            >
              {done ? '✓ ' : ''}{s.label}{s.long ? ' ⏳' : ''}
            </span>
          )
        })}
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-gray-800">
        <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-gray-400">
        <span>{progress ? `${progress.completed_units} / ${progress.total_units} fits` : 'starting…'}</span>
        <span>{pct}% · ETA {eta}</span>
      </div>
    </div>
  )
}
