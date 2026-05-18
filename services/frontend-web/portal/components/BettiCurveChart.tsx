'use client';
import { useTopologyStream } from '@/hooks/useTopologyStream';
import type { StrategyOutput } from '@/types/trader';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';

export function BettiCurveChart({ initial = null }: { initial?: StrategyOutput | null } = {}) {
  const { features } = useTopologyStream(initial);

  // Strategy state messaging:
  //   - no features yet           → still connecting to the websocket; show skeleton
  //   - features but no betti     → active strategy doesn't compute TDA; say so explicitly
  //   - features with betti       → render the chart
  if (!features) {
    return (
      <div className="bg-gray-900 rounded-lg p-4">
        <h2 className="text-lg font-semibold text-white mb-2">Topology Shape</h2>
        <p className="text-xs text-gray-400">Connecting to feature stream…</p>
        <div className="animate-pulse bg-gray-800 rounded h-48 mt-4" />
      </div>
    );
  }

  if (!features.betti_curves) {
    return (
      <div className="bg-gray-900 rounded-lg p-4">
        <h2 className="text-lg font-semibold text-white mb-2">Topology Shape</h2>
        <p className="text-xs text-gray-400">
          Topology features inactive — active strategy is{' '}
          <code className="text-amber-400">{features.strategy_id ?? 'unknown'}</code>.
          Switch <code>ACTIVE_STRATEGY</code> to <code>topology_v1</code> to populate this chart.
        </p>
        <div className="bg-gray-800 rounded h-48 mt-4 flex items-center justify-center text-gray-500 text-xs">
          no Betti curves
        </div>
      </div>
    );
  }

  const { epsilon_range, beta0, beta1 } = features.betti_curves;
  const data = epsilon_range.map((eps, i) => ({
    epsilon: eps.toFixed(3),
    'β₀ (components)': beta0[i],
    'β₁ (loops)': beta1[i],
  }));

  return (
    <div className="bg-gray-900 rounded-lg p-4">
      <h2 className="text-lg font-semibold text-white mb-1">Topology Shape</h2>
      <p className="text-xs text-gray-400 mb-4">
        Last rebalance topology snapshot — updates weekly.
        β₀ = connected components; β₁ = independent loops.
        High β₁ at intermediate ε signals structural tension.
      </p>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data}>
          <XAxis dataKey="epsilon" tick={{ fill: '#9ca3af', fontSize: 10 }} />
          <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} />
          <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: 'none', color: '#fff' }} />
          <Legend />
          <Line type="monotone" dataKey="β₀ (components)" stroke="#60a5fa" dot={false} />
          <Line type="monotone" dataKey="β₁ (loops)" stroke="#f472b6" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
