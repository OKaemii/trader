// Local copy of @trader/shared-types for the standalone Next.js portal.
// Keep in sync with packages/shared-types/src/index.ts.

export interface StrategyOutput {
  timestamp: number;
  strategy_id: string;
  ticker_universe: string[];
  composite_scores: Record<string, number>;
  factor_attributions: Record<string, Record<string, number>>;
  sectors: Record<string, string>;
  covariance_matrix: number[][];
  regime_confidence: number;
  betti_curves?: { epsilon_range: number[]; beta0: number[]; beta1: number[] };
  persistence_pairs?: Array<[number, number, number]>;
  laplacian_residuals?: Record<string, number>;
}

// Mirror of @trader/shared-types PollIntervalOption. Kept on the FE so the portal
// stays single-package-deep on its types/trader.ts copy.
export type PollIntervalTier = 'intraday' | 'hourly' | 'daily'

export interface PollIntervalOption {
  key:   string
  ms:    number
  label: string
  tier:  PollIntervalTier
}

export interface ProviderInfo {
  name:                 string
  maxLookbackMs:        number
  allowedPollIntervals: PollIntervalOption[]
}

export type SignalLifecycle =
  | 'pending'
  | 'approved'
  | 'queued'
  | 'executing'
  | 'executed'
  | 'closed'
  | 'failed'
  | 'cancelled';

export type SignalFailureReason =
  | 'cash_insufficient'
  | 'market_drift'
  | 'queue_expired'
  | 'broker_rejected'
  | 'retries_exhausted'
  | 'manual_cancel';

export interface TradeSignalDTO {
  id: string;
  timestamp: number;
  ticker: string;
  strategy_id: string;
  action: 'BUY' | 'SELL' | 'HOLD';
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
  attempts?: number;
  lastAttemptAt?: number;
  failureReason?: SignalFailureReason;
  failureDetail?: string;
}

export interface SignalProgressDTO extends TradeSignalDTO {
  currentPrice: number | null;
  currentWeight: number;
  pnlPct: number | null;
  ageMs: number;
  lifecycleResolved: SignalLifecycle;
}

export interface SignalRationale {
  plain_english: string;
  economic_mechanism: string;
  factor_exposures: Record<string, number>;
  residual_alpha: number;
  topology_contribution: string;
  uncertainty: 'high' | 'medium' | 'low';
}
