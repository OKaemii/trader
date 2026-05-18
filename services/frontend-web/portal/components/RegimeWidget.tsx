'use client';
import { useTopologyStream } from '@/hooks/useTopologyStream';
import type { StrategyOutput } from '@/types/trader';

export function RegimeWidget({ initial = null }: { initial?: StrategyOutput | null } = {}) {
  const { features } = useTopologyStream(initial);
  const confidence = features?.regime_confidence ?? null;

  const label = confidence === null ? 'Loading...'
    : confidence >= 0.7 ? 'Stable'
    : confidence >= 0.4 ? 'Transitioning'
    : 'Unstable';

  const color = confidence === null ? 'text-gray-400'
    : confidence >= 0.7 ? 'text-green-400'
    : confidence >= 0.4 ? 'text-yellow-400'
    : 'text-red-400';

  return (
    <div className="bg-gray-900 rounded-lg p-4">
      <h2 className="text-lg font-semibold text-white mb-2">Regime</h2>
      <div className="flex items-center gap-3">
        <span className={`text-2xl font-bold ${color}`}>{label}</span>
        {confidence !== null && (
          <span className="text-gray-400 text-sm">
            confidence {(confidence * 100).toFixed(0)}%
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 mt-2">
        Position sizes scale with regime confidence. At 30%, positions are 30% of normal.
      </p>
    </div>
  );
}
