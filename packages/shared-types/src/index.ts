export interface OHLCVBar {
  ticker: string;
  timestamp: number;    // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;        // primary price — adjusted if adjustmentFactor is set, otherwise raw
  volume: number;
  rawClose?: number;    // unadjusted closing price (stored when a corporate-action adjustment is applied)
  adjustedClose?: number;
  adjustmentFactor?: number;
}

// StrategyOutput is the inter-service contract between strategy-engine (Python) and signal-service (TS).
// topology-specific fields are optional — only populated by TopologyStrategy.
export interface StrategyOutput {
  timestamp: number;
  strategy_id: string;                                       // e.g. 'factor_rank_v1', 'topology_v1'
  ticker_universe: string[];
  composite_scores: Record<string, number>;                  // ticker → ranked score (higher = more bullish)
  factor_attributions: Record<string, Record<string, number>>;  // ticker → {factor: contribution}
  sectors: Record<string, string>;                           // ticker → GICS sector
  covariance_matrix: number[][];                             // shrunk covariance (Ledoit-Wolf)
  regime_confidence: number;                                 // [0,1] — stability of current regime
  position_size_multiplier?: number;                         // [0.25, 1.0] — from RegimeState
  signal_weights?: Record<string, number>;                   // factor → weight (topology fades in crisis)
  feature_stability?: {                                      // FeatureStabilityReport summary
    stability_score: number;
    n_unstable: number;
    features: Array<{ name: string; cv: number; is_stationary: boolean }>;
  };
  betti_curves?: { epsilon_range: number[]; beta0: number[]; beta1: number[] };
  persistence_pairs?: Array<[number, number, number]>;
  laplacian_residuals?: Record<string, number>;
}

// TopologyFeatures — retained for backward-compatible dashboard reads only.
// Core pipeline uses StrategyOutput. Do not add new service dependencies on this type.
export interface TopologyFeatures {
  timestamp: number;
  ticker_universe: string[];
  laplacian_residuals: Record<string, number>;
  betti_curves: { epsilon_range: number[]; beta0: number[]; beta1: number[] };
  persistence_pairs: Array<[number, number, number]>;
}

// Lifecycle states for a TradeSignal — see TradeSignal entity for transitions.
//   pending  → just emitted, awaiting approval (paper mode default for SELL/BUY)
//   approved → admin approved (or auto-approved in unrestricted mode)
//   executed → order placed and filled by trading-service
//   closed   → position exited (exitPrice + closedAt populated)
export type SignalLifecycle = 'pending' | 'approved' | 'executed' | 'closed';

// TradeSignalDTO — wire format for MongoDB storage and notifications.
// Domain entity (TradeSignal class) has the same fields; this is the plain-object form.
export interface TradeSignalDTO {
  id: string;
  timestamp: number;
  ticker: string;
  strategy_id: string;                 // e.g. 'factor_rank_v1', 'topology_v1'
  action: 'BUY' | 'SELL' | 'HOLD';  // SELL = reduce/exit long; never initiates a short (v1 long-only)
  confidence: number;                  // 0-1
  targetWeight: number;                // [0,1] portfolio weight; 0 = exit position
  rationale: string;                   // JSON-serialised SignalRationale
  features_snapshot?: StrategyOutput;
  approved?: boolean;
  // Progress / lifecycle fields — populated as the signal flows through approve / execute / close.
  // All optional for backwards compatibility with signals written before these fields existed.
  entryPrice?: number;                 // close-of-bar price at emission, used for P&L
  lifecycle?: SignalLifecycle;
  approvedAt?: number;                 // unix ms
  executedAt?: number;                 // unix ms — set by trading-service after fill
  closedAt?: number;                   // unix ms — set when position is exited
  exitPrice?: number;                  // price at close, paired with closedAt
}

// SignalProgressDTO — enriched view served by /api/signals/progress for the portal.
// Built by joining a TradeSignalDTO with the latest market quote and current portfolio weight.
export interface SignalProgressDTO extends TradeSignalDTO {
  currentPrice: number | null;     // latest close from OHLCV bars; null if unavailable
  currentWeight: number;           // ticker's weight in current portfolio (0 if not held)
  pnlPct: number | null;           // direction-aware return since emission; null if no entryPrice
  ageMs: number;                   // now - timestamp
  lifecycleResolved: SignalLifecycle;  // lifecycle with reasonable defaults applied
}

export interface SignalRationale {
  plain_english: string;              // one sentence a non-quant can act on
  economic_mechanism: string;         // which known microstructure phenomenon drives this
  factor_exposures: Record<string, number>;  // factor → attribution
  residual_alpha: number;             // alpha after factor attribution (must be positive)
  topology_contribution: string;      // what TDA features added over simpler factors
  uncertainty: 'high' | 'medium' | 'low';
}

// Redis stream keys (use xAdd/xReadGroup — NOT publish/subscribe)
export const REDIS_STREAMS = {
  MARKET_RAW:       'market:raw',        // market-data-service → strategy-engine
  STRATEGY_OUTPUT:  'signals:strategy',  // strategy-engine → signal-service
  TRADE_SIGNALS:    'signals:trade',     // signal-service → notification-service
} as const;

// Redis pub/sub channels — ephemeral dashboard events only (not the trading pipeline)
export const REDIS_PUBSUB = {
  STRATEGY_DASHBOARD: 'strategy:dashboard',   // strategy-engine publishes after each cycle for WS feeds
  NOTIFICATIONS:      'notifications:pending',
} as const;
