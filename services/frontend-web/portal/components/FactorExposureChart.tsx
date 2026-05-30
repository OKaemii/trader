'use client';
import { useTopologyStream } from '@/hooks/useTopologyStream';
import type { StrategyOutput } from '@/types/trader';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine,
  ResponsiveContainer, Cell,
} from 'recharts';

const FACTOR_LABELS: Record<string, string> = {
  momentum: 'Momentum',
  reversal: 'Reversal',
  low_vol: 'Low Vol',
  topology: 'TDA',
  residual_alpha: 'Residual α',
};

export function FactorExposureChart({ initial = null }: { initial?: StrategyOutput | null } = {}) {
  const { features } = useTopologyStream(initial);

  if (!features?.factor_attributions) {
    return (
      <div className="bg-gray-900 rounded-lg p-4">
        <h2 className="text-lg font-semibold text-white mb-2">Factor Exposures</h2>
        <p className="text-xs text-gray-400">Portfolio-level factor attributions from last cycle</p>
        <div className="animate-pulse bg-gray-800 rounded h-48 mt-4" />
      </div>
    );
  }

  // Portfolio-level factor tilt — conviction-weighted over the HELD set, not the
  // full universe. The per-ticker attributions are cross-sectional z-scores, whose
  // universe-wide mean is ≈0 by construction; flat-averaging them across all ~190
  // names cancels every factor to zero (the bug this replaced). Instead we restrict
  // to the top-K names the strategy actually holds (by composite score) and weight
  // each by its positive composite score — a proxy for the optimiser's conviction.
  const scores = features.composite_scores ?? {};
  const candidates = (features.ticker_universe ?? Object.keys(features.factor_attributions))
    .filter((t) => features.factor_attributions[t])
    .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  const topK = features.top_k && features.top_k > 0 ? features.top_k : candidates.length;
  const held = candidates.slice(0, topK);

  // Positive-clamped composite scores as weights; fall back to equal weight if the
  // held set has no positive conviction (degenerate cycle).
  const rawWeights = held.map((t) => Math.max(0, scores[t] ?? 0));
  const weightSum = rawWeights.reduce((s, w) => s + w, 0);
  const weights = weightSum > 1e-9
    ? rawWeights.map((w) => w / weightSum)
    : held.map(() => 1 / Math.max(held.length, 1));

  const aggregate: Record<string, number> = {};
  held.forEach((ticker, idx) => {
    const attrs = features.factor_attributions[ticker];
    if (!attrs) return;
    for (const [factor, value] of Object.entries(attrs)) {
      aggregate[factor] = (aggregate[factor] ?? 0) + value * weights[idx];
    }
  });

  const data = Object.entries(aggregate)
    .filter(([k]) => k in FACTOR_LABELS)
    .map(([factor, value]) => ({ factor: FACTOR_LABELS[factor] ?? factor, value }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  return (
    <div className="bg-gray-900 rounded-lg p-4">
      <h2 className="text-lg font-semibold text-white mb-1">Factor Exposures</h2>
      <p className="text-xs text-gray-400 mb-4">
        Conviction-weighted factor tilt of the held set (top-{held.length}) from last strategy cycle
      </p>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} layout="vertical" margin={{ left: 16, right: 16 }}>
          <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 10 }} tickFormatter={(v) => v.toFixed(2)} />
          <YAxis type="category" dataKey="factor" tick={{ fill: '#d1d5db', fontSize: 11 }} width={72} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1f2937', border: 'none', color: '#fff' }}
            formatter={(v) => [(v as number).toFixed(3), 'Attribution']}
          />
          <ReferenceLine x={0} stroke="#4b5563" />
          <Bar dataKey="value" radius={[0, 3, 3, 0]}>
            {data.map((entry) => (
              <Cell key={entry.factor} fill={entry.value >= 0 ? '#34d399' : '#f87171'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
