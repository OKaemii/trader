import { SignalFeed } from '@/components/SignalFeed';
import { BettiCurveChart } from '@/components/BettiCurveChart';
import { FactorExposureChart } from '@/components/FactorExposureChart';
import { RegimeWidget } from '@/components/RegimeWidget';
import { StrategyHealthBanner } from '@/components/StrategyHealthBanner';
import { QuantOnly } from '@/components/QuantOnly';
import { authedFetch } from '@/app/lib/auth-fetch';
import { getSystemHealth } from '@/app/lib/system-health';
import type { StrategyOutput, SignalProgressDTO } from '@/types/trader';

// Market-wide signals view (IA-redesign Task 8 — was app/(authed)/signals/page.tsx, the
// list view; the /signals/[id] detail route is owned by a separate card and stays a real
// page). Research Task 23 made the Research workspace symbol-centric, so the per-symbol
// Signals question-tab (SignalsTab.tsx) is now distinct from THIS cross-sectional feed. The
// landing (no ?symbol=) renders this for the /signals stub deep-link (/research?tab=signals),
// preserving the whole-market signal feed; a per-symbol Signals tab (T25) replaces it once a
// symbol is selected.
async function fetchJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const r = await authedFetch(path);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function MarketSignalsTab() {
  // SSR every widget's seed data in parallel — the tab paints fully populated on
  // first byte. Strategy-engine's `strategy:latest_output` powers RegimeWidget,
  // FactorExposureChart, BettiCurveChart; signal-service exposes it via the
  // `/admin/api/signals/topology/snapshot` REST endpoint (and warm-replays it on the
  // WebSocket upgrade for live reconnects). SignalFeed seeds from
  // `/api/signals/progress`; StrategyHealthBanner from the shared getSystemHealth() fan-out
  // (server components can't fetch their own /portal-api/* route).
  const [snapshot, signalsBody, health, strat] = await Promise.all([
    fetchJsonOrNull<{ data: StrategyOutput | null }>('/admin/api/signals/topology/snapshot'),
    fetchJsonOrNull<{ signals?: SignalProgressDTO[] }>('/api/signals/progress'),
    getSystemHealth(),
    fetchJsonOrNull<{ active?: string }>('/admin/api/strategy/list'),
  ]);
  const topo = snapshot?.data ?? null;
  const signals = signalsBody?.signals ?? [];
  const count = (a: 'BUY' | 'SELL' | 'HOLD') => signals.filter((s) => s.action === a).length;
  const buys = count('BUY'), sells = count('SELL'), holds = count('HOLD');
  // `active` = the currently-selected strategy (matches Build · Strategy; sourced from strategy/list).
  // `emitted` = the strategy that produced the signals shown below — the last cycle strategy-engine
  // actually ran (strategy:latest_output). They diverge right after a switch (no new cycle yet) and stay
  // split while a monthly-rebalanced strategy is active, so we label them distinctly instead of conflating
  // both under one "Strategy" chip (which read as "the active strategy is X" and made a real switch look inert).
  const active = strat?.active ?? null;
  const emitted = topo?.strategy_id ?? signals[0]?.strategy_id ?? null;
  const emittedTs = topo?.timestamp ?? signals[0]?.timestamp ?? null;
  const regime = topo?.regime_confidence ?? null;

  return (
    <div className="grid grid-cols-2 gap-6">
      <div className="col-span-2 space-y-3">
        <p className="text-sm text-gray-400">
          The latest cross-sectional signals from the most recent strategy-engine cycle, with the regime + factor context that produced them.
          Each card shows live P&amp;L vs. entry and a fill-progress bar.
        </p>
        {/* Summary strip — at-a-glance cycle state so the tab leads with substance, not just a list. */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {active && <Chip label="Active" value={active} mono />}
          {emitted && active !== emitted && <Chip label="Signals from" value={emitted} mono tone="muted" />}
          {!active && emitted && <Chip label="Strategy" value={emitted} mono />}
          <Chip label="Signals" value={String(signals.length)} />
          <Chip label="Buy" value={String(buys)} tone="emerald" />
          <Chip label="Sell" value={String(sells)} tone="red" />
          <Chip label="Hold" value={String(holds)} tone="muted" />
          {regime !== null && <Chip label="Regime" value={`${(regime * 100).toFixed(0)}%`} tone={regime >= 0.5 ? 'emerald' : 'amber'} />}
        </div>
        {active && emitted && active !== emitted && (
          <p className="text-xs text-amber-300">
            Active strategy <span className="font-mono">{active}</span> — the signals below are from the last emitted cycle
            (<span className="font-mono">{emitted}</span>{emittedTs ? `, ${agoLabel(emittedTs)}` : ''}); they refresh when{' '}
            <span className="font-mono">{active}</span> next emits a cycle (a monthly-rebalanced strategy only re-emits on its rebalance).
          </p>
        )}
      </div>
      <StrategyHealthBanner initial={health} />
      <div className="col-span-2 md:col-span-1">
        <SignalFeed initial={signalsBody?.signals ?? null} />
      </div>
      <div className="col-span-2 flex flex-col gap-4 md:col-span-1">
        <RegimeWidget initial={topo} />
        {/* Factor-decomposition + topology (Betti) are quant-only — Beginner mode curates them
            away, but the regime context + signal feed above stay visible in both modes. */}
        <QuantOnly>
          <FactorExposureChart initial={topo} />
          <BettiCurveChart initial={topo} />
        </QuantOnly>
      </div>
    </div>
  );
}

// Coarse "how stale" label for the last-emitted-cycle timestamp. Server-rendered per request, so
// Date.now() is fine here (the tab is dynamic — cookie-derived authedFetch).
function agoLabel(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 3_600_000) return 'within the hour';
  const h = Math.floor(ms / 3_600_000);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
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
