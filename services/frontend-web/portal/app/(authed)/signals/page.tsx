import { SignalFeed } from '@/components/SignalFeed';
import { BettiCurveChart } from '@/components/BettiCurveChart';
import { FactorExposureChart } from '@/components/FactorExposureChart';
import { RegimeWidget } from '@/components/RegimeWidget';
import { StrategyHealthBanner } from '@/components/StrategyHealthBanner';
import { authedFetch } from '@/app/lib/auth-fetch';
import type { StrategyOutput, SignalProgressDTO } from '@/types/trader';

async function fetchJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const r = await authedFetch(path);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

interface ServiceHealth { name: string; ok: boolean; status?: number }

export default async function SignalsPage() {
  // SSR every widget's seed data in parallel — the page paints fully populated on
  // first byte. Strategy-engine's `strategy:latest_output` powers RegimeWidget,
  // FactorExposureChart, BettiCurveChart; signal-service exposes it via the
  // `/admin/api/signals/topology/snapshot` REST endpoint we added (and warm-replays
  // it on the WebSocket upgrade for live reconnects). SignalFeed seeds from
  // `/api/signals/progress`; StrategyHealthBanner from `/api/admin/system/health`.
  const [snapshot, signalsBody, health] = await Promise.all([
    fetchJsonOrNull<{ data: StrategyOutput | null }>('/admin/api/signals/topology/snapshot'),
    fetchJsonOrNull<{ signals?: SignalProgressDTO[] }>('/api/signals/progress'),
    fetchJsonOrNull<ServiceHealth[]>('/api/admin/system/health'),
  ]);
  const topo = snapshot?.data ?? null;
  return (
    <div className="grid grid-cols-2 gap-6 p-6">
      <div className="col-span-2">
        <h1 className="text-2xl font-bold text-white">Trade Signals</h1>
        <p className="mt-1 text-sm text-gray-400">
          Signals are generated weekly. Paper mode — no automated orders. Live P&amp;L vs. entry price; weight bar shows fill progress.
        </p>
      </div>
      <StrategyHealthBanner initial={health} />
      <div className="col-span-2 md:col-span-1">
        <SignalFeed initial={signalsBody?.signals ?? null} />
      </div>
      <div className="col-span-2 flex flex-col gap-4 md:col-span-1">
        <RegimeWidget initial={topo} />
        <FactorExposureChart initial={topo} />
        <BettiCurveChart initial={topo} />
      </div>
    </div>
  );
}
