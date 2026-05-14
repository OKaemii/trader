import type { SignalLifecycle } from '@trader/shared-types';

export type Action = 'BUY' | 'SELL' | 'HOLD';
export type { SignalLifecycle };

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
  public readonly entryPrice?: number;
  public readonly lifecycle: SignalLifecycle;
  public readonly approvedAt?: number;
  public readonly executedAt?: number;
  public readonly closedAt?: number;
  public readonly exitPrice?: number;
  // Real share count attributed to this signal at fill time (BUYs only). Set by FillsPoller
  // when a BUY order fills, then decremented as later SELLs FIFO-consume the position.
  // Used for round-trip closure: a SELL fill walks open BUYs oldest-first and closes them
  // until executedQuantity is fully consumed.
  public readonly executedQuantity?: number;

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
    executedAt?: number;
    closedAt?: number;
    exitPrice?: number;
    executedQuantity?: number;
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
    // Derive default lifecycle from existing fields so old persisted docs still resolve sensibly.
    this.lifecycle = params.lifecycle
      ?? (params.closedAt ? 'closed'
        : params.executedAt ? 'executed'
        : (params.approved ?? false) ? 'approved'
        : 'pending');
    this.approvedAt = params.approvedAt;
    this.executedAt = params.executedAt;
    this.closedAt = params.closedAt;
    this.exitPrice = params.exitPrice;
    this.executedQuantity = params.executedQuantity;
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
