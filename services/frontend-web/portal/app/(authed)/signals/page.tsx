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
  const signals = signalsBody?.signals ?? [];
  const count = (a: 'BUY' | 'SELL' | 'HOLD') => signals.filter((s) => s.action === a).length;
  const buys = count('BUY'), sells = count('SELL'), holds = count('HOLD');
  const strategyId = topo?.strategy_id ?? signals[0]?.strategy_id ?? null;
  const regime = topo?.regime_confidence ?? null;

  return (
    <div className="grid grid-cols-2 gap-6 p-6">
      <div className="col-span-2 space-y-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Trade Signals</h1>
          <p className="mt-1 text-sm text-gray-400">
            The latest cross-sectional signals from the active strategy, with the regime + factor context that produced them.
            Each card shows live P&amp;L vs. entry and a fill-progress bar.
          </p>
        </div>
        {/* Summary strip — at-a-glance cycle state so the page leads with substance, not just a list. */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {strategyId && <Chip label="Strategy" value={strategyId} mono />}
          <Chip label="Signals" value={String(signals.length)} />
          <Chip label="Buy" value={String(buys)} tone="emerald" />
          <Chip label="Sell" value={String(sells)} tone="red" />
          <Chip label="Hold" value={String(holds)} tone="muted" />
          {regime !== null && <Chip label="Regime" value={`${(regime * 100).toFixed(0)}%`} tone={regime >= 0.5 ? 'emerald' : 'amber'} />}
        </div>
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

function Chip({ label, value, tone, mono }: { label: string; value: string; tone?: 'emerald' | 'red' | 'amber' | 'muted'; mono?: boolean }) {
  const color = tone === 'emerald' ? 'text-emerald-400' : tone === 'red' ? 'text-red-400'
    : tone === 'amber' ? 'text-amber-300' : tone === 'muted' ? 'text-gray-400' : 'text-gray-100';
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-gray-800 bg-gray-900 px-2.5 py-1">
      <span className="uppercase tracking-wide text-gray-500">{label}</span>
      <span className={`${color} ${mono ? 'font-mono' : 'font-semibold'}`}>{value}</span>
    </span>
  );
}
