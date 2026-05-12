'use client';
import { useTopologyStream } from '@/hooks/useTopologyStream';
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

export function FactorExposureChart() {
  const { features } = useTopologyStream();

  if (!features?.factor_attributions) {
    return (
      <div className="bg-gray-900 rounded-lg p-4">
        <h2 className="text-lg font-semibold text-white mb-2">Factor Exposures</h2>
        <p className="text-xs text-gray-400">Portfolio-level factor attributions from last cycle</p>
        <div className="animate-pulse bg-gray-800 rounded h-48 mt-4" />
      </div>
    );
  }

  // Aggregate portfolio-level factor exposures from all tickers
  const aggregate: Record<string, number> = {};
  const tickers = features.ticker_universe ?? Object.keys(features.factor_attributions);
  for (const ticker of tickers) {
    const attrs = features.factor_attributions[ticker];
    if (!attrs) continue;
    for (const [factor, value] of Object.entries(attrs)) {
      aggregate[factor] = (aggregate[factor] ?? 0) + value / tickers.length;
    }
  }

  const data = Object.entries(aggregate)
    .filter(([k]) => k in FACTOR_LABELS)
    .map(([factor, value]) => ({ factor: FACTOR_LABELS[factor] ?? factor, value }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  return (
    <div className="bg-gray-900 rounded-lg p-4">
      <h2 className="text-lg font-semibold text-white mb-1">Factor Exposures</h2>
      <p className="text-xs text-gray-400 mb-4">
        Portfolio-average factor attributions from last strategy cycle
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
