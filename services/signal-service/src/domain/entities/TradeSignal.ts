export type Action = 'BUY' | 'SELL' | 'HOLD';

export class TradeSignal {
  public readonly id: string;
  public readonly timestamp: number;
  public readonly ticker: string;
  public readonly action: Action;
  public readonly confidence: number;   // 0-1
  public readonly targetWeight: number; // [0,1] — long-only; SELL means reduce/exit a long, never short
  public readonly rationale: string;
  public readonly approved: boolean;

  constructor(params: {
    id: string;
    timestamp: number;
    ticker: string;
    action: Action;
    confidence: number;
    targetWeight: number;
    rationale: string;
    approved?: boolean;
  }) {
    if (params.confidence < 0 || params.confidence > 1)
      throw new Error('confidence must be in [0, 1]');
    if (params.targetWeight < 0 || params.targetWeight > 1)
      throw new Error('targetWeight must be in [0, 1] (long-only)');

    this.id = params.id;
    this.timestamp = params.timestamp;
    this.ticker = params.ticker;
    this.action = params.action;
    this.confidence = params.confidence;
    this.targetWeight = params.targetWeight;
    this.rationale = params.rationale;
    this.approved = params.approved ?? false;
  }

  // minConfidence is strategy policy — not a domain invariant.
  // Source from env/config; it will vary by regime, strategy, and retraining cycle.
  isActionable(minConfidence: number): boolean {
    return this.action !== 'HOLD' && this.confidence >= minConfidence;
  }
}
