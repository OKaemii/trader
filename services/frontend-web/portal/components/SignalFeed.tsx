'use client';
import { useEffect, useState } from 'react';
import type { TradeSignalDTO, SignalRationale } from '@/types/trader';

export function SignalFeed() {
  const [signals, setSignals] = useState<TradeSignalDTO[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/signals')
      .then((r) => r.json())
      .then(({ signals }) => { setSignals(signals ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="animate-pulse bg-gray-800 rounded-lg h-64" />;

  return (
    <div className="bg-gray-900 rounded-lg p-4">
      <h2 className="text-lg font-semibold text-white mb-4">Signal Feed</h2>
      {signals.length === 0 && <p className="text-gray-400">No signals yet.</p>}
      {signals.map((s) => {
        const rationale: SignalRationale | null = (() => {
          try { return JSON.parse(s.rationale); } catch { return null; }
        })();
        return (
          <div key={s.id} className="border border-gray-700 rounded p-3 mb-3">
            <div className="flex items-center justify-between">
              <span className="font-bold text-white">{s.ticker}</span>
              <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                s.action === 'BUY' ? 'bg-green-600' : 'bg-red-600'
              } text-white`}>{s.action}</span>
            </div>
            <p className="text-gray-300 text-sm mt-1">
              {rationale?.plain_english ?? s.rationale}
            </p>
            <div className="flex gap-4 mt-2 text-xs text-gray-400">
              <span>Confidence: {(s.confidence * 100).toFixed(0)}%</span>
              <span>Target: {(s.targetWeight * 100).toFixed(1)}%</span>
              {rationale?.uncertainty && <span>Uncertainty: {rationale.uncertainty}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
