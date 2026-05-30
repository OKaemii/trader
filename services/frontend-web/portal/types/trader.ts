// Local copy of @trader/shared-types for the standalone Next.js portal.
// Keep in sync with packages/shared-types/src/index.ts.

// Money + Currency mirror. The portal receives `{amount, currency}` JSON from
// /portal-api/admin/trading/cash and /api/portfolio. Format helpers below render
// per-currency without hardcoding GBP.
export type Currency = 'GBP' | 'USD'
export interface Money { readonly amount: number; readonly currency: Currency }

export function formatMoney(m: Money | undefined | null): string {
  if (!m || typeof m.amount !== 'number') return '—'
  return m.amount.toLocaleString(undefined, { style: 'currency', currency: m.currency })
}

export interface StrategyOutput {
  timestamp: number;
  strategy_id: string;
  ticker_universe: string[];
  composite_scores: Record<string, number>;
  factor_attributions: Record<string, Record<string, number>>;
  sectors: Record<string, string>;
  covariance_matrix: number[][];
  regime_confidence: number;
  top_k?: number;                       // held-position count (top-K by composite score)
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

// OrderType — mirrors services/trading-service/src/domain/entities/Order.ts. Numeric;
// 0 = Limit, 1 = Market. Reorder = silent data corruption.
export enum OrderType {
  Limit,
  Market,
}

// MUST mirror the member order of packages/shared-types/src/index.ts SignalLifecycle.
// Numeric values are the wire format — the portal receives `{lifecycle: 4}` from the
// API and compares against `SignalLifecycle.Executed`. Reorder = silent data corruption.
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

export enum SignalFailureReason {
  CashInsufficient,
  MarketDrift,
  QueueExpired,
  BrokerRejected,
  RetriesExhausted,
  ManualCancel,
}

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
