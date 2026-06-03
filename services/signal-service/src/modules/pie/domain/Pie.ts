// Pie — a reusable, uniquely-identified holdings basket. One *active* pie per strategy holds
// its current target weights + a rebalance history. Strategy-agnostic by design: any strategy
// can own a pie (v1 enables it for high_velocity_v1). Signals/orders carry the pieId so the
// whole book is attributable to the pie that produced it. Execution stays on the existing
// fractional-order rails — the pie is the internal record, not a Trading212 native pie.

export interface PieTarget {
  ticker: string;
  targetWeight: number;   // [0,1]
}

export interface PieRebalance {
  at: number;             // Unix ms
  reason: string;         // e.g. 'rebalance', 'monthly_rebalance'
  targets: PieTarget[];
}

export interface Pie {
  pieId: string;          // uuid — stable across rebalances
  strategyId: string;
  name: string;
  status: 'active' | 'archived';
  baseCurrency: string;   // 'GBP'
  targets: PieTarget[];   // current targets
  rebalanceHistory: PieRebalance[];   // most-recent first, capped
  createdAt: number;
  updatedAt: number;
}

export interface IPieRepository {
  findActiveByStrategy(strategyId: string): Promise<Pie | null>;
  findById(pieId: string): Promise<Pie | null>;
  listAll(): Promise<Pie[]>;
  /** Upsert the active pie for a strategy: set the new targets + append a rebalance entry. */
  upsertActive(strategyId: string, targets: PieTarget[], at: number, reason: string): Promise<Pie>;
}
