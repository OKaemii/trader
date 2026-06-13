import type { Db } from 'mongodb';
import type { Logger } from '@trader/core';
import type { PriorAppearance, TelemetrySnapshotResponse } from '@trader/contracts';
import { COLLECTIONS } from '@trader/shared-mongo';
import { SignalLifecycle } from '@trader/shared-types';
import { sumPositionsGBP, sumOpenPnlGBP, type FxConverter, type PositionDoc } from '@trader/shared-portfolio';
import type { StrategyDecayMonitor } from '../../approval/application/StrategyDecayMonitor.ts';
import type { RiskEngine } from '../../risk/application/RiskEngine.ts';
import { tryIdentityOf, tickerOf } from '../../../shared/identity.ts';

// market → instrument currency. Storage carries the bare `market` since Task 16a, which is the
// instrument-currency discriminator (US → USD, LSE → GBP) — no DB round-trip needed. Keeps the
// realised-P&L FX path identical to the trading-service order-sizing path.
function currencyOfMarket(market: string): 'USD' | 'GBP' {
  return market === 'US' ? 'USD' : 'GBP';
}

// (symbol, market) → the T212 display ticker, falling back to the bare symbol if the market is
// unrecognised (so a corrupt row still renders a human-readable label).
function safeTicker(symbol: string, market: string): string {
  try { return tickerOf(symbol, market); } catch { return symbol; }
}

interface ClosedSignalDoc {
  _id: string;
  symbol: string;
  market: string;
  action: string;
  entryPrice?: number;
  exitPrice?: number;
  executedQuantity?: number;
  closedAt?: Date;
}

const LIFECYCLE_KEYS = [
  SignalLifecycle.Pending,
  SignalLifecycle.Approved,
  SignalLifecycle.Queued,
  SignalLifecycle.Executing,
  SignalLifecycle.Executed,
  SignalLifecycle.Closed,
  SignalLifecycle.Failed,
  SignalLifecycle.Cancelled,
] as const;

// Order matches TelemetrySnapshotResponse['lifecycleCounters'] keys.
const LIFECYCLE_LABELS = [
  'pending', 'approved', 'queued', 'executing', 'executed', 'closed', 'failed', 'cancelled',
] as const;

export class GetTelemetrySnapshotUseCase {
  constructor(
    private readonly db: Db,
    private readonly fx: FxConverter,
    private readonly decayMonitor: StrategyDecayMonitor,
    private readonly riskEngine: RiskEngine,
    private readonly logger: Logger,
  ) {}

  async execute(
    since: number,
    opts: { tickers?: readonly string[]; strategyId?: string } = {},
  ): Promise<TelemetrySnapshotResponse> {
    const computedAt = Date.now();
    const signals   = this.db.collection(COLLECTIONS.SIGNALS);
    const positions = this.db.collection(COLLECTIONS.POSITIONS);

    // Closed signals since `since`. Must be in {executed, closed} per the failure invariant
    // — failed signals don't contribute to realised P&L. Only `Closed` carries exitPrice
    // (Executed is still in-flight), so the realised query is naturally Closed-only.
    const closedSinceQuery = signals
      .find({
        lifecycle: SignalLifecycle.Closed,
        closedAt:  { $gte: new Date(since) },
        entryPrice: { $exists: true, $gt: 0 },
        exitPrice:  { $exists: true, $gt: 0 },
      })
      .project<ClosedSignalDoc>({ _id: 1, symbol: 1, market: 1, action: 1, entryPrice: 1, exitPrice: 1, executedQuantity: 1, closedAt: 1 });

    const closed = await closedSinceQuery.toArray();

    let pnlGbpTotal = 0;
    let best: { ticker: string; pnlPct: number; pnlGbp: number } | null = null;
    let worst: { ticker: string; pnlPct: number; pnlGbp: number } | null = null;

    for (const doc of closed) {
      const entry = doc.entryPrice!;
      const exit  = doc.exitPrice!;
      const qty   = doc.executedQuantity ?? 0;
      const dir   = doc.action === 'SELL' ? -1 : 1;
      const pnlPct = ((exit - entry) / entry) * dir;
      const pnlNative = (exit - entry) * qty * dir;
      // Re-derive the display ticker from the stored identity (best-effort — a corrupt market
      // falls back to the bare symbol for the label, currency to GBP).
      const ticker = doc.symbol && doc.market ? safeTicker(doc.symbol, doc.market) : (doc.symbol ?? '');
      let pnlGbp = 0;
      if (qty > 0) {
        try {
          pnlGbp = await this.fx.toGBP({ amount: pnlNative, currency: currencyOfMarket(doc.market) });
        } catch (err) {
          this.logger.warn({ err, ticker }, 'fx unavailable for realised pnl; gbp degraded to 0');
        }
      }
      pnlGbpTotal += pnlGbp;
      const pick = { ticker, pnlPct, pnlGbp };
      if (best  === null || pnlPct > best.pnlPct)  best  = pick;
      if (worst === null || pnlPct < worst.pnlPct) worst = pick;
    }

    // Lifecycle counters — point-in-time, not since-windowed. Operators want to see
    // the in-flight queue depth ("how many are waiting / failed right now") not a
    // historical accumulation. `since` only narrows realisedSinceLast.
    const lifecycleAgg = await signals
      .aggregate<{ _id: number; n: number }>([
        { $group: { _id: '$lifecycle', n: { $sum: 1 } } },
      ])
      .toArray();
    const counterByLifecycle: Record<number, number> = {};
    for (const row of lifecycleAgg) counterByLifecycle[row._id] = row.n;
    const lifecycleCounters = LIFECYCLE_KEYS.reduce<Record<string, number>>((acc, key, idx) => {
      acc[LIFECYCLE_LABELS[idx]!] = counterByLifecycle[key] ?? 0;
      return acc;
    }, {}) as TelemetrySnapshotResponse['lifecycleCounters'];

    // Open positions MTM. sumPositionsGBP owns the FX call; throws when fx is unavailable.
    // We degrade to mtmGbp=0 and surface `fxDegraded: true` rather than failing the snapshot
    // (the email still wants to render with whatever telemetry IS available).
    const posDocs = await positions.find({}).toArray() as unknown as PositionDoc[];
    let mtmGbp = 0;
    let openPnl = { pnlGbp: 0, costBasisGbp: 0, marketValueGbp: 0, covered: 0, total: posDocs.length };
    let fxDegraded = false;
    try {
      mtmGbp = await sumPositionsGBP(posDocs, this.fx);
      // Open (unrealised) P&L: market value − cost basis over positions with a known averagePrice.
      // This is the number operators actually want ("how are my holdings doing"), since realised
      // P&L stays 0 until a round-trip closes.
      openPnl = await sumOpenPnlGBP(posDocs, this.fx);
    } catch (err) {
      this.logger.warn({ err }, 'fx unavailable for open-mtm/pnl; reporting 0 with fxDegraded=true');
      fxDegraded = true;
    }

    const lastDecay = await this.decayMonitor.getLastMetrics();
    const decayHealth = lastDecay ? this.decayMonitor.checkHealth(lastDecay) : 'healthy';

    // Risk status is folded in here (rather than a separate /risk/status internal
    // endpoint) so the TelemetryBuilder consumer can populate the entire risk panel
    // of the report with one HTTP call. The admin /admin/api/signals/risk/status
    // route still exists for portal consumption.
    const risk = await this.riskEngine.status().catch((err) => {
      this.logger.warn({ err }, 'risk.status() failed; reporting zeros');
      return null;
    });

    // ── History block ──────────────────────────────────────────────────
    // previousDigestAt: timestamp of the most recent signal for `strategyId` strictly
    // before `since` — proxy for "when did the prior digest fire" (one signal-cluster
    // = one digest). signalsSinceLastDigest counts signals emitted between that point
    // and `since`. priorAppearances: per-ticker, the most recent prior signal regardless
    // of strategy (operator wants to know if this ticker was *anywhere* before).
    // Note: `timestamp` is persisted as a Mongo `Date` (see toSignalDoc), so range
    // queries MUST cross the type boundary with `new Date(...)`. Comparing a Date
    // field against a Number uses BSON type-ordering and returns no matches — a
    // silent bug we hit on the first deploy.
    const sinceDate = new Date(since);
    let previousDigestAt: number | null = null;
    let signalsSinceLastDigest = 0;
    if (opts.strategyId) {
      const prior = await signals
        .find({ strategy_id: opts.strategyId, timestamp: { $lt: sinceDate } })
        .project<{ timestamp: Date }>({ timestamp: 1 })
        .sort({ timestamp: -1 })
        .limit(1)
        .toArray();
      previousDigestAt = prior[0]?.timestamp.getTime() ?? null;
      if (previousDigestAt !== null) {
        signalsSinceLastDigest = await signals.countDocuments({
          strategy_id: opts.strategyId,
          timestamp:   { $gte: new Date(previousDigestAt), $lt: sinceDate },
        });
      }
    }

    const priorAppearances: Record<string, PriorAppearance> = {};
    for (const ticker of opts.tickers ?? []) {
      // Storage is keyed on (symbol, market); split the requested T212 ticker, fail-soft (an
      // un-routable name simply has no prior appearance — same as a name that never emitted).
      const id = tryIdentityOf(ticker);
      if (!id) continue;
      const prior = await signals
        .find({ symbol: id.symbol, market: id.market, timestamp: { $lt: sinceDate } })
        .project<{ timestamp: Date; action: string; lifecycle?: number; entryPrice?: number; exitPrice?: number }>(
          { timestamp: 1, action: 1, lifecycle: 1, entryPrice: 1, exitPrice: 1 },
        )
        .sort({ timestamp: -1 })
        .limit(1)
        .toArray();
      const p = prior[0];
      if (!p) continue;
      const action = p.action === 'BUY' || p.action === 'SELL' || p.action === 'HOLD' ? p.action : 'BUY';
      const lifecycleName = typeof p.lifecycle === 'number'
        ? (LIFECYCLE_NAMES[p.lifecycle] ?? 'Pending')
        : 'Pending';
      const pnlPct = (p.lifecycle === SignalLifecycle.Closed && p.entryPrice && p.exitPrice && p.entryPrice > 0)
        ? ((p.exitPrice - p.entryPrice) / p.entryPrice) * (action === 'SELL' ? -1 : 1)
        : null;
      const priorTs = p.timestamp.getTime();
      priorAppearances[ticker] = {
        lastSignalAt: priorTs,
        action,
        ageDays:      Math.max(0, (since - priorTs) / 86_400_000),
        lifecycle:    lifecycleName,
        pnlPct,
      };
    }

    return {
      since,
      computedAt,
      realisedSinceLast: {
        closedSignals: closed.length,
        pnlGbp: pnlGbpTotal,
        bestPick:  best,
        worstPick: worst,
      },
      lifecycleCounters,
      openPositions: {
        count: posDocs.length,
        mtmGbp,
        fxDegraded,
        unrealisedPnlGbp: openPnl.pnlGbp,
        costBasisGbp:     openPnl.costBasisGbp,
        pnlCoveredCount:  openPnl.covered,
      },
      risk: {
        navGbp:       risk?.nav                   ?? 0,
        hwmGbp:       risk?.hwm                   ?? 0,
        dailyLossPct: risk?.daily_loss_pct        ?? 0,
        drawdownPct:  risk?.drawdown_from_hwm_pct ?? 0,
        circuit: {
          open:   risk?.circuit_open   ?? false,
          reason: risk?.circuit_reason ?? null,
        },
      },
      decay: {
        health: decayHealth,
        metrics: lastDecay,
      },
      history: {
        previousDigestAt,
        signalsSinceLastDigest,
        priorAppearances,
      },
    };
  }
}

const LIFECYCLE_NAMES: Record<number, string> = {
  [SignalLifecycle.Pending]:   'Pending',
  [SignalLifecycle.Approved]:  'Approved',
  [SignalLifecycle.Queued]:    'Queued',
  [SignalLifecycle.Executing]: 'Executing',
  [SignalLifecycle.Executed]:  'Executed',
  [SignalLifecycle.Closed]:    'Closed',
  [SignalLifecycle.Failed]:    'Failed',
  [SignalLifecycle.Cancelled]: 'Cancelled',
};
