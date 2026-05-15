// Canonical poll-interval enum. The portal renders these as a dropdown (no free-form
// ms input — operators can't accidentally set 1ms and DDOS Yahoo). Each provider
// declares which subset it supports via `allowedPollIntervals`, so swapping providers
// reshapes the dropdown automatically. `tier` is purely cosmetic — drives chip colour
// on the portal so intraday vs daily are visually distinct.
export const POLL_INTERVALS = {
  '10s':  10_000,
  '1m':   60_000,
  '5m':   300_000,
  '15m':  900_000,
  '1h':   3_600_000,
  '24h':  86_400_000,
} as const satisfies Record<string, number>;

export type PollIntervalKey = keyof typeof POLL_INTERVALS;
export type PollIntervalMs  = typeof POLL_INTERVALS[PollIntervalKey];

export interface PollIntervalOption {
  key:   PollIntervalKey;
  ms:    number;
  label: string;                                // dropdown copy: "Every 5 minutes"
  tier:  'intraday' | 'hourly' | 'daily';      // portal chip colour bucket
}

export const POLL_INTERVAL_OPTIONS: Record<PollIntervalKey, PollIntervalOption> = {
  '10s':  { key: '10s',  ms: POLL_INTERVALS['10s'],  label: 'Every 10 seconds', tier: 'intraday' },
  '1m':   { key: '1m',   ms: POLL_INTERVALS['1m'],   label: 'Every minute',     tier: 'intraday' },
  '5m':   { key: '5m',   ms: POLL_INTERVALS['5m'],   label: 'Every 5 minutes',  tier: 'intraday' },
  '15m':  { key: '15m',  ms: POLL_INTERVALS['15m'],  label: 'Every 15 minutes', tier: 'intraday' },
  '1h':   { key: '1h',   ms: POLL_INTERVALS['1h'],   label: 'Every hour',       tier: 'hourly'   },
  '24h':  { key: '24h',  ms: POLL_INTERVALS['24h'],  label: 'Every day',        tier: 'daily'    },
};

export function pollIntervalKeyForMs(ms: number): PollIntervalKey | null {
  for (const k of Object.keys(POLL_INTERVALS) as PollIntervalKey[]) {
    if (POLL_INTERVALS[k] === ms) return k;
  }
  return null;
}

// Granularity tag for OHLCV bars. The same ticker can hold rows at multiple intervals
// (e.g. daily for strategy warmup, 5m for intraday testing) without colliding — the
// (ticker, timestamp, interval) compound index dedups within an interval while letting
// the cache serve different cadences. Older rows that pre-date this field default to
// 'daily' in the Mongo reader since that's what market-data-service was emitting.
export type BarInterval = 'daily' | '5m' | '15m' | '1h';

// ── Currency / Money ─────────────────────────────────────────────────────────
// Two-currency system today (US + LSE listings). `BASE_CURRENCY` is what NAV, HWM,
// position weights and every aggregated reporting figure resolve to. Pence ('GBp' /
// 'GBX') is killed at the market-data boundary by dividing by 100 and tagging GBP —
// downstream code never sees pence.
export type Currency = 'GBP' | 'USD';
export const BASE_CURRENCY: Currency = 'GBP';

// Currency-tagged amount. Used at every API boundary (HTTP responses, Mongo docs that
// hold currency-bearing values). Internal arithmetic that mixes currencies must go
// through @trader/shared-fx FxClient — the type system can't enforce that, but every
// `m.amount` access without an FxClient call should be reviewed.
export interface Money {
  readonly amount: number;
  readonly currency: Currency;
}
export const money = (amount: number, currency: Currency): Money => ({ amount, currency });

// Bars carry the listing currency so consumers that need to FX-convert (NAV, position
// sizing) can. Strategy math reads `close` directly because returns are scale-invariant
// (np.diff(np.log(prices)) is dimensionless), so currency doesn't enter that path.
export interface OHLCVBar {
  ticker: string;
  timestamp: number;    // Unix ms — bar START time. Daily bars use 00:00:00Z of the trading day.
  interval?: BarInterval;
  currency?: Currency;  // Set by the provider; absent on legacy rows pre-FX work.
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
//   Pending   → just emitted, awaiting approval (paper mode default for SELL/BUY)
//   Approved  → admin approved (or auto-approved by AutoApprovalGate)
//   Queued    → handed to trading-service dispatcher; awaiting send to T212. Retries
//               also live in this state — `attempts > 0` indicates a retry-in-progress.
//   Executing → claimed by the dispatcher, in-flight to T212 (short-lived; reverted to
//               Queued by the boot sweep if a pod crashes mid-call).
//   Executed  → T212 accepted the order (submit/fill confirmed by FillsPoller).
//   Closed    → round-trip closed (exitPrice + closedAt populated).
//   Failed    → terminal: conditions changed (drift, cash, expiry), broker rejected, or
//               attempts cap reached. Excluded from strategy/portfolio accounting — the
//               order is treated as if it never happened.
//   Cancelled → terminal: explicit cancel from broker history (T212 CANCELLED/REJECTED/EXPIRED).
//
// Numeric enum: persisted to Mongo as integer; reverse-lookup via `SignalLifecycle[x]`
// gives the member name for logs/UI. Member order is the canonical position — appending
// new states is safe; reordering breaks every persisted doc.
export enum SignalLifecycle {
  Pending,
  Approved,
  Queued,
  Executing,
  Executed,
  Closed,
  Failed,
  Cancelled,
}

// Why a signal landed in `Failed`. Surfaced in the portal next to the row.
export enum SignalFailureReason {
  CashInsufficient,      // computed quantity rounded to zero against current cash
  MarketDrift,           // mid-price moved past PRICE_DRIFT_TOLERANCE since emission
  QueueExpired,          // aged past QUEUE_TTL_MS before successful send
  BrokerRejected,        // T212 returned a non-retryable 4xx
  RetriesExhausted,      // hit ORDER_MAX_ATTEMPTS on transient errors (429 / network)
  ManualCancel,          // admin clicked Cancel in the portal
}

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
  executedQuantity?: number;           // shares actually filled (for FIFO round-trip)
  // Queue / failure bookkeeping. `attempts` increments on every dispatcher claim; if it
  // reaches ORDER_MAX_ATTEMPTS the signal is moved to `failed` with reason `retries_exhausted`.
  attempts?: number;
  lastAttemptAt?: number;              // unix ms — set whenever the dispatcher claims the row
  failureReason?: SignalFailureReason;
  failureDetail?: string;              // free-text from the underlying error / context
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
