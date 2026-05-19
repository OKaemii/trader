import type { Db } from 'mongodb';
import type { Logger } from '@trader/core';
import type { TelemetrySnapshotResponse } from '@trader/contracts';
import { COLLECTIONS } from '@trader/shared-mongo';
import { SignalLifecycle } from '@trader/shared-types';
import { sumPositionsGBP, type FxConverter, type PositionDoc } from '@trader/shared-portfolio';
import type { StrategyDecayMonitor } from '../../approval/application/StrategyDecayMonitor.ts';
import type { RiskEngine } from '../../risk/application/RiskEngine.ts';

// ticker → instrument currency. T212 suffix carries this — no DB round-trip needed.
// Keeps the realised-P&L FX path identical to the trading-service order-sizing path.
function inferCurrency(ticker: string): 'USD' | 'GBP' {
  return /_US_EQ$/.test(ticker) ? 'USD' : 'GBP';
}

interface ClosedSignalDoc {
  _id: string;
  ticker: string;
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

  async execute(since: number): Promise<TelemetrySnapshotResponse> {
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
      .project<ClosedSignalDoc>({ _id: 1, ticker: 1, action: 1, entryPrice: 1, exitPrice: 1, executedQuantity: 1, closedAt: 1 });

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
      let pnlGbp = 0;
      if (qty > 0) {
        try {
          pnlGbp = await this.fx.toGBP({ amount: pnlNative, currency: inferCurrency(doc.ticker) });
        } catch (err) {
          this.logger.warn({ err, ticker: doc.ticker }, 'fx unavailable for realised pnl; gbp degraded to 0');
        }
      }
      pnlGbpTotal += pnlGbp;
      const pick = { ticker: doc.ticker, pnlPct, pnlGbp };
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
    let fxDegraded = false;
    try {
      mtmGbp = await sumPositionsGBP(posDocs, this.fx);
    } catch (err) {
      this.logger.warn({ err }, 'fx unavailable for open-mtm; reporting 0 with fxDegraded=true');
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
    };
  }
}
