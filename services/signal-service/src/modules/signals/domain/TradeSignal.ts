import { SignalLifecycle, SignalFailureReason, type StrategyOutput } from '@trader/shared-types';

export type Action = 'BUY' | 'SELL' | 'HOLD';
export { SignalLifecycle, SignalFailureReason };

export class TradeSignal {
  public readonly id: string;
  public readonly timestamp: number;
  public readonly ticker: string;
  public readonly strategy_id: string;  // e.g. 'factor_rank_v1', 'topology_v1'
  public readonly action: Action;
  public readonly confidence: number;   // 0-1
  public readonly targetWeight: number; // [0,1] — long-only; SELL means reduce/exit a long, never short
  public readonly rationale: string;
  public readonly approved: boolean;

  // Progress / lifecycle — optional, populated as the signal flows through the system.
  public readonly entryPrice?: number | undefined;
  public readonly lifecycle: SignalLifecycle;
  public readonly approvedAt?: number | undefined;
  // Wall-clock ms the signal entered the dispatch queue (lifecycle → Queued). The queue
  // TTL is measured from THIS, not from emission `timestamp` — so approval latency (a
  // slow auto-approve sweep, a backlog flush) can never by itself expire a signal; only
  // genuine queue-sitting does. Price staleness is guarded separately by the drift gate.
  public readonly queuedAt?: number | undefined;
  public readonly executedAt?: number | undefined;
  public readonly closedAt?: number | undefined;
  public readonly exitPrice?: number | undefined;
  public readonly executedQuantity?: number | undefined;

  public readonly attempts: number;
  public readonly lastAttemptAt?: number | undefined;
  public readonly failureReason?: SignalFailureReason | undefined;
  public readonly failureDetail?: string | undefined;

  // Pie attribution — the internal Pie (holdings basket) this signal belongs to. Stamped by
  // GenerateSignals for pie-managed strategies (high_velocity_v1); absent for others.
  public readonly pieId?: string | undefined;

  // Trimmed StrategyOutput snapshot — populated by GenerateSignals with just enough
  // context (sector + score for THIS ticker, regime, position multiplier, strategy id)
  // for downstream notification enrichment. covariance_matrix + ticker_universe are
  // intentionally empty to keep the wire/Mongo payload small; full StrategyOutputs are
  // ~75KB at universe=98 due to the NxN covariance matrix.
  public readonly features_snapshot?: StrategyOutput | undefined;

  constructor(params: {
    id: string;
    timestamp: number;
    ticker: string;
    strategy_id: string;
    action: Action;
    confidence: number;
    targetWeight: number;
    rationale: string;
    approved?: boolean;
    entryPrice?: number;
    lifecycle?: SignalLifecycle;
    approvedAt?: number;
    queuedAt?: number;
    executedAt?: number;
    closedAt?: number;
    exitPrice?: number;
    executedQuantity?: number;
    attempts?: number;
    lastAttemptAt?: number;
    failureReason?: SignalFailureReason;
    failureDetail?: string;
    features_snapshot?: StrategyOutput;
    pieId?: string;
  }) {
    if (params.confidence < 0 || params.confidence > 1)
      throw new Error('confidence must be in [0, 1]');
    if (params.targetWeight < 0 || params.targetWeight > 1)
      throw new Error('targetWeight must be in [0, 1] (long-only)');
    if (params.entryPrice !== undefined && params.entryPrice <= 0)
      throw new Error('entryPrice must be positive when provided');

    this.id = params.id;
    this.timestamp = params.timestamp;
    this.ticker = params.ticker;
    this.strategy_id = params.strategy_id;
    this.action = params.action;
    this.confidence = params.confidence;
    this.targetWeight = params.targetWeight;
    this.rationale = params.rationale;
    this.approved = params.approved ?? false;
    this.entryPrice = params.entryPrice;
    // Derive default lifecycle from existing fields so old persisted docs still resolve
    // sensibly. The lifecycle field on the entity itself is the numeric enum; values
    // coming from JSON / Mongo are integers (no string coercion needed).
    this.lifecycle = params.lifecycle
      ?? (params.closedAt ? SignalLifecycle.Closed
        : params.executedAt ? SignalLifecycle.Executed
        : (params.approved ?? false) ? SignalLifecycle.Approved
        : SignalLifecycle.Pending);
    this.approvedAt = params.approvedAt;
    this.queuedAt = params.queuedAt;
    this.executedAt = params.executedAt;
    this.closedAt = params.closedAt;
    this.exitPrice = params.exitPrice;
    this.executedQuantity = params.executedQuantity;
    this.attempts = params.attempts ?? 0;
    this.lastAttemptAt = params.lastAttemptAt;
    this.failureReason = params.failureReason;
    this.failureDetail = params.failureDetail;
    this.features_snapshot = params.features_snapshot;
    this.pieId = params.pieId;
  }

  // minConfidence is strategy policy — not a domain invariant.
  // Source from env/config; it will vary by regime, strategy, and retraining cycle.
  isActionable(minConfidence: number): boolean {
    return this.action !== 'HOLD' && this.confidence >= minConfidence;
  }

  // Direction-aware P&L vs. entry. SELL signals profit when price falls below entry.
  // Returns null if entryPrice is missing or currentPrice is non-positive.
  pnlPct(currentPrice: number | null | undefined): number | null {
    if (!this.entryPrice || !currentPrice || currentPrice <= 0) return null;
    const ret = (currentPrice - this.entryPrice) / this.entryPrice;
    return this.action === 'SELL' ? -ret : ret;
  }
}
