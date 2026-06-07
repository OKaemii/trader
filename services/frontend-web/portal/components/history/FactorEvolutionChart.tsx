'use client'

import { useMemo } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { Explain } from '@/components/Explain'

// Factor Evolution — the four factor PERCENTILES over time for one symbol, from strategy-engine's
// factor-history endpoint (T10: GET /portal-api/admin/strategy/factor-history?ticker=). Each point
// is a cross-sectional percentile in [0,100]; `null` is a genuine gap (pre-backfill / Quality &
// Value are forward-only per §H) and is rendered as a break in the line — never a fabricated 0.
//
// Advanced factor diagnostic — the History tab mounts it under <QuantOnly> (it adds depth; it is
// never a safety surface). Display-only: these percentiles come from the persisted factor_scores
// store, the same the live strategy computes — we visualise, we don't recompute.
export interface FactorHistoryPoint {
  observation_ts: number
  momentum: number | null
  quality: number | null
  value: number | null
  volatility: number | null
}

const FACTORS = [
  { key: 'momentum', label: 'Momentum', color: '#34d399' },
  { key: 'value', label: 'Value', color: '#60a5fa' },
  { key: 'quality', label: 'Quality', color: '#fbbf24' },
  { key: 'volatility', label: 'Volatility', color: '#f472b6' },
] as const

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function FactorEvolutionChart({ points }: { points: FactorHistoryPoint[] }) {
  const data = useMemo(
    () =>
      [...points]
        .sort((a, b) => a.observation_ts - b.observation_ts)
        .map((p) => ({
          date: fmtDate(p.observation_ts),
          // recharts draws a line break for a `null` y — exactly the "gap, not a 0" semantics we want
          // for a percentile that wasn't computed (e.g. a forward-only Quality/Value pre-backfill).
          momentum: p.momentum,
          value: p.value,
          quality: p.quality,
          volatility: p.volatility,
        })),
    [points],
  )

  if (data.length === 0) {
    return (
      <div className="rounded border border-gray-800 bg-gray-900/40 p-6 text-sm text-gray-400">
        No factor history for this symbol yet. Percentiles accrue as the strategy persists per-cycle
        factor scores; Quality and Value are forward-only (no deep historical fundamentals — §H), so
        their lines start once the snapshot store has data.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="inline-flex items-center gap-1.5 text-sm text-gray-400">
        Cross-sectional factor percentiles over time (0–100; higher = stronger relative to the universe).
        <Explain id="factorExposure" />
      </p>
      <div className="rounded border border-gray-800 bg-gray-900 p-2">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
            <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 10 }} minTickGap={48} />
            <YAxis domain={[0, 100]} tick={{ fill: '#9ca3af', fontSize: 10 }} width={36} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: 'none', color: '#fff', fontSize: 12 }}
              formatter={(v, name) => [v == null ? 'n/a' : `${(v as number).toFixed(0)} pct`, name as string]}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <ReferenceLine y={50} stroke="#374151" strokeDasharray="3 3" />
            {FACTORS.map((f) => (
              <Line
                key={f.key}
                type="monotone"
                dataKey={f.key}
                name={f.label}
                stroke={f.color}
                dot={false}
                strokeWidth={1.5}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
