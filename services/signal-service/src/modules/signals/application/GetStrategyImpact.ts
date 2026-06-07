import type { Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import { SignalLifecycle } from '@trader/shared-types';
import {
  buildStrategyImpact,
  type StrategyImpactRow,
  type StrategyImpactSnapshot,
  type StrategyImpactSignal,
} from './StrategyImpact.ts';

// Reads the two own-service collections the strategy-impact metrics derive from and feeds the pure
// buildStrategyImpact aggregation. signal-service owns both held_set_snapshots (T11) and signals,
// so there's no cross-service /internal hop here — no 403 trap for authenticated QA.

// held_set_snapshots projection — only the fields buildStrategyImpact reads.
interface SnapshotDoc {
  strategy_id?:      string;
  observation_ts?:   number;
  ticker?:           string;
  rank?:             number;
  selected?:         boolean;
  holding_age_days?: number;
}

// signals projection — the contribution calc needs action + entry/exit + strategy.
interface SignalDoc {
  strategy_id?: string;
  ticker?:      string;
  action?:      string;
  lifecycle?:   number;
  entryPrice?:  number;
  exitPrice?:   number;
}

export class GetStrategyImpactUseCase {
  constructor(private readonly db: Db) {}

  async execute(ticker: string): Promise<StrategyImpactRow[]> {
    if (!ticker) return [];

    const snapshotsColl = this.db.collection<SnapshotDoc>(COLLECTIONS.HELD_SET_SNAPSHOTS);
    const signalsColl   = this.db.collection<SignalDoc>(COLLECTIONS.SIGNALS);

    const [snapDocs, sigDocs] = await Promise.all([
      // Every snapshot for the ticker — served by the (strategy_id, ticker, observation_ts)
      // index from T11. Bounded by cycles×strategies; a hard limit guards a pathological history.
      snapshotsColl
        .find({ ticker }, { projection: { _id: 0 } })
        .sort({ observation_ts: 1 })
        .limit(20_000)
        .toArray(),
      // Only executed/closed signals count toward contribution (failure invariant — a failed or
      // cancelled order never happened). Push the filter to Mongo so failed rows never reach the
      // pure layer.
      signalsColl
        .find(
          { ticker, lifecycle: { $in: [SignalLifecycle.Executed, SignalLifecycle.Closed] } },
          { projection: { _id: 0, strategy_id: 1, ticker: 1, action: 1, lifecycle: 1, entryPrice: 1, exitPrice: 1 } },
        )
        .toArray(),
    ]);

    const snapshots: StrategyImpactSnapshot[] = snapDocs.map((d) => ({
      strategy_id:      d.strategy_id ?? '',
      observation_ts:   d.observation_ts ?? 0,
      ticker:           d.ticker ?? ticker,
      rank:             d.rank ?? 0,
      selected:         d.selected ?? false,
      holding_age_days: d.holding_age_days ?? 0,
    }));

    const signals: StrategyImpactSignal[] = sigDocs.map((d) => ({
      strategy_id: d.strategy_id ?? '',
      ticker:      d.ticker ?? ticker,
      action:      d.action ?? '',
      lifecycle:   (d.lifecycle ?? SignalLifecycle.Pending) as SignalLifecycle,
      entryPrice:  d.entryPrice,
      exitPrice:   d.exitPrice,
    }));

    return buildStrategyImpact(snapshots, signals);
  }
}
