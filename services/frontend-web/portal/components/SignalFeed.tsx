'use client';
import { useEffect, useState } from 'react';
import type { SignalProgressDTO, SignalRationale } from '@/types/trader';
import { SignalLifecycle, SignalFailureReason } from '@/types/trader';

// SignalFailureReason is a numeric enum on the wire; convert to "Market drift" etc.
// for the operator-facing failure line. Unknown integers fall back to the bare number.
function failureReasonLabel(reason: number | string): string {
  if (typeof reason === 'string') return reason.replace(/_/g, ' ');
  const name = SignalFailureReason[reason];
  if (!name) return `unknown (${reason})`;
  return name.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
}
import { MARKET_STYLES, marketOf } from './market';
import { MarketBadge } from './MarketBadge';

const REFRESH_MS = 30_000;

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

const lifecycleStyles: Record<SignalLifecycle, string> = {
  [SignalLifecycle.Pending]:   'bg-gray-700 text-gray-200',
  [SignalLifecycle.Approved]:  'bg-blue-600 text-white',
  [SignalLifecycle.Queued]:    'bg-indigo-700 text-white',
  [SignalLifecycle.Executing]: 'bg-purple-600 text-white animate-pulse',
  [SignalLifecycle.Executed]:  'bg-amber-600 text-white',
  [SignalLifecycle.Closed]:    'bg-slate-600 text-gray-200',
  [SignalLifecycle.Failed]:    'bg-red-700 text-white',
  [SignalLifecycle.Cancelled]: 'bg-stone-600 text-gray-200',
};

// Display label for the chip. Queued+attempts>0 reads as "Retrying (n/5)" so the user
// can see at a glance that the dispatcher is actively retrying vs sitting idle.
function lifecycleLabel(state: SignalLifecycle, attempts: number, maxAttempts: number): string {
  if (state === SignalLifecycle.Queued && attempts > 0) return `Retrying (${attempts}/${maxAttempts})`;
  if (state === SignalLifecycle.Queued)     return 'Queued';
  if (state === SignalLifecycle.Executing)  return 'Sending to broker';
  if (state === SignalLifecycle.Executed)   return 'Submitted';
  if (state === SignalLifecycle.Failed)     return 'Failed';
  if (state === SignalLifecycle.Cancelled)  return 'Cancelled';
  if (state === SignalLifecycle.Approved)   return 'Approved';
  if (state === SignalLifecycle.Closed)     return 'Closed';
  return 'Awaiting approval';
}

function LifecycleBadge({
  state, attempts, maxAttempts, failureReason,
}: {
  state: SignalLifecycle; attempts: number; maxAttempts: number; failureReason?: SignalFailureReason;
}) {
  const label = lifecycleLabel(state, attempts, maxAttempts);
  const title = state === SignalLifecycle.Failed && failureReason !== undefined
    ? `Failed: ${failureReasonLabel(failureReason)}`
    : undefined;
  return (
    <span
      title={title}
      className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wide font-semibold ${lifecycleStyles[state]}`}
    >
      {label}
    </span>
  );
}

const MAX_ATTEMPTS_DISPLAY = 5;
type LifecycleFilter = 'all' | 'in-transit' | 'failed' | 'closed';

function matchesFilter(state: SignalLifecycle, filter: LifecycleFilter): boolean {
  if (filter === 'all')         return true;
  if (filter === 'in-transit')  return state === SignalLifecycle.Queued || state === SignalLifecycle.Executing;
  if (filter === 'failed')      return state === SignalLifecycle.Failed;
  if (filter === 'closed')      return state === SignalLifecycle.Closed;
  return true;
}

function PnLPill({ pnlPct }: { pnlPct: number | null }) {
  if (pnlPct === null) return <span className="text-gray-500 text-xs">P&amp;L —</span>;
  const positive = pnlPct >= 0;
  const colour = positive ? 'text-green-400' : 'text-red-400';
  return (
    <span className={`${colour} text-xs font-mono`}>
      {positive ? '+' : ''}{(pnlPct * 100).toFixed(2)}%
    </span>
  );
}

function WeightProgress({ current, target }: { current: number; target: number }) {
  // Render filled portion as the lesser of (current, target). Overshoots clip to 100%.
  const safeTarget = Math.max(target, 1e-6);
  const ratio = Math.min(1, Math.max(0, current / safeTarget));
  return (
    <div className="flex items-center gap-2 text-xs text-gray-400">
      <div className="flex-1 h-1.5 bg-gray-800 rounded overflow-hidden">
        <div
          className="h-full bg-indigo-500 transition-all"
          style={{ width: `${(ratio * 100).toFixed(1)}%` }}
        />
      </div>
      <span className="font-mono text-[10px] whitespace-nowrap">
        {(current * 100).toFixed(1)}% / {(target * 100).toFixed(1)}%
      </span>
    </div>
  );
}

export function SignalFeed() {
  const [signals, setSignals] = useState<SignalProgressDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<LifecycleFilter>('all');

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/portal-api/signals/progress')
        .then((r) => r.json())
        .then(({ signals }) => {
          if (cancelled) return;
          setSignals(signals ?? []);
          setLoading(false);
        })
        .catch(() => { if (!cancelled) setLoading(false); });
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  async function retry(signal: SignalProgressDTO) {
    setErrorMsg(null);
    setBusyId(signal.id);
    try {
      const res = await fetch(`/portal-api/admin/signals/retry/${encodeURIComponent(signal.id)}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrorMsg(`Retry failed (${res.status}): ${body.error ?? 'unknown'}`);
      }
    } catch (e) {
      setErrorMsg(`Retry error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(signal: SignalProgressDTO) {
    if (!window.confirm(`Cancel ${signal.action} ${signal.ticker}? The signal will be marked failed and the strategy will treat it as if it never happened.`)) return;
    setErrorMsg(null);
    setBusyId(signal.id);
    try {
      const res = await fetch(`/portal-api/admin/signals/cancel/${encodeURIComponent(signal.id)}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrorMsg(`Cancel failed (${res.status}): ${body.error ?? 'unknown'}`);
      }
    } catch (e) {
      setErrorMsg(`Cancel error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function approve(signal: SignalProgressDTO) {
    // Confirm explicitly because in demo/live mode this places a real broker order.
    const msg = `Approve ${signal.action} ${signal.ticker} (target ${(signal.targetWeight * 100).toFixed(1)}%)?\n\nThis triggers a real order on the active TRADING_MODE.`;
    if (!window.confirm(msg)) return;

    setErrorMsg(null);
    setApprovingId(signal.id);
    // Optimistic local update so the lifecycle badge flips immediately; the next refresh
    // will reconcile to whatever the backend actually persisted.
    setSignals((prev) => prev.map((s) => s.id === signal.id ? { ...s, lifecycleResolved: SignalLifecycle.Approved, approved: true } : s));
    try {
      const res = await fetch(`/portal-api/admin/signals/approve/${encodeURIComponent(signal.id)}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrorMsg(`Approve failed (${res.status}): ${body.error ?? 'unknown'}`);
        // Roll back the optimistic update on failure.
        setSignals((prev) => prev.map((s) => s.id === signal.id ? { ...s, lifecycleResolved: signal.lifecycleResolved, approved: signal.approved } : s));
      }
    } catch (e) {
      setErrorMsg(`Approve error: ${e instanceof Error ? e.message : String(e)}`);
      setSignals((prev) => prev.map((s) => s.id === signal.id ? { ...s, lifecycleResolved: signal.lifecycleResolved, approved: signal.approved } : s));
    } finally {
      setApprovingId(null);
    }
  }

  if (loading) return <div className="animate-pulse bg-gray-800 rounded-lg h-64" />;

  const filtered = signals.filter((s) => {
    const lc = s.lifecycleResolved ?? s.lifecycle ?? (s.approved ? SignalLifecycle.Approved : SignalLifecycle.Pending);
    return matchesFilter(lc, filter);
  });

  const filters: Array<{ key: LifecycleFilter; label: string }> = [
    { key: 'all',         label: 'All' },
    { key: 'in-transit',  label: 'In transit' },
    { key: 'failed',      label: 'Failed' },
    { key: 'closed',      label: 'Closed' },
  ];

  return (
    <div className="bg-gray-900 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Signal Feed</h2>
        <span className="text-[10px] text-gray-500">refreshes every {REFRESH_MS / 1000}s</span>
      </div>
      <div className="flex gap-2 mb-3">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wide font-semibold ${
              filter === f.key ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {errorMsg && <p className="text-red-400 text-xs mb-3">{errorMsg}</p>}
      {filtered.length === 0 && <p className="text-gray-400">No signals match this filter.</p>}
      {filtered.map((s) => {
        const rationale: SignalRationale | null = (() => {
          try { return JSON.parse(s.rationale); } catch { return null; }
        })();
        const lifecycle = s.lifecycleResolved ?? s.lifecycle ?? (s.approved ? SignalLifecycle.Approved : SignalLifecycle.Pending);
        const market = marketOf(s.ticker);
        const accent = MARKET_STYLES[market].border;
        return (
          <div key={s.id} className={`border border-gray-700 border-l-2 ${accent} rounded p-3 mb-3`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <MarketBadge market={market} />
                <span className="font-bold text-white">{s.ticker}</span>
                <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                  s.action === 'BUY' ? 'bg-green-600' : 'bg-red-600'
                } text-white`}>{s.action}</span>
                <LifecycleBadge
                  state={lifecycle}
                  attempts={s.attempts ?? 0}
                  maxAttempts={MAX_ATTEMPTS_DISPLAY}
                  failureReason={s.failureReason}
                />
              </div>
              <div className="flex items-center gap-3">
                {lifecycle === SignalLifecycle.Pending && (
                  <button
                    type="button"
                    onClick={() => approve(s)}
                    disabled={approvingId === s.id}
                    className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wide font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white"
                  >
                    {approvingId === s.id ? '…' : 'Approve'}
                  </button>
                )}
                {lifecycle === SignalLifecycle.Failed && (
                  <button
                    type="button"
                    onClick={() => retry(s)}
                    disabled={busyId === s.id}
                    className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wide font-semibold bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white"
                  >
                    {busyId === s.id ? '…' : 'Retry'}
                  </button>
                )}
                {(lifecycle === SignalLifecycle.Queued || lifecycle === SignalLifecycle.Executing) && (
                  <button
                    type="button"
                    onClick={() => cancel(s)}
                    disabled={busyId === s.id}
                    className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wide font-semibold bg-stone-700 hover:bg-stone-600 disabled:opacity-50 text-white"
                  >
                    {busyId === s.id ? '…' : 'Cancel'}
                  </button>
                )}
                <PnLPill pnlPct={s.pnlPct} />
                <span className="text-[10px] text-gray-500" title={new Date(s.timestamp).toISOString()}>
                  {formatAge(s.ageMs)}
                </span>
              </div>
            </div>
            {lifecycle === SignalLifecycle.Failed && s.failureReason !== undefined && (
              <p className="text-red-400 text-xs mt-2">
                {/* SignalFailureReason is numeric; render the member name (e.g. 'MarketDrift') */}
                {failureReasonLabel(s.failureReason)}{s.failureDetail ? ` — ${s.failureDetail}` : ''}
              </p>
            )}
            {(s.attempts ?? 0) > 0 && lifecycle !== SignalLifecycle.Failed && lifecycle !== SignalLifecycle.Executed && lifecycle !== SignalLifecycle.Closed && (
              <p className="text-amber-400 text-[10px] mt-1">attempt {s.attempts}/{MAX_ATTEMPTS_DISPLAY}</p>
            )}
            <p className="text-gray-300 text-sm mt-2">
              {rationale?.plain_english ?? s.rationale}
            </p>
            <div className="mt-2">
              <WeightProgress current={s.currentWeight} target={s.targetWeight} />
            </div>
            <div className="flex gap-4 mt-2 text-xs text-gray-400">
              <span>Conf: {(s.confidence * 100).toFixed(0)}%</span>
              {s.entryPrice !== undefined && (
                <span className="font-mono">
                  Entry ${s.entryPrice.toFixed(2)}
                  {s.currentPrice !== null && (
                    <> → ${s.currentPrice.toFixed(2)}</>
                  )}
                </span>
              )}
              {rationale?.uncertainty && <span>Uncertainty: {rationale.uncertainty}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
