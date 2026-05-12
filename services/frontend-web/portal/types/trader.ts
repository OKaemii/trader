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
}

export interface SignalRationale {
  plain_english: string;
  economic_mechanism: string;
  factor_exposures: Record<string, number>;
  residual_alpha: number;
  topology_contribution: string;
  uncertainty: 'high' | 'medium' | 'low';
}
