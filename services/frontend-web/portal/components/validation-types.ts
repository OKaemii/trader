// Local mirror of backtest-engine's ValidationReportV2 + the job document
// (services/backtest-engine/src/application/validator.py, .../job_runner.py). Per the portal
// convention we don't import service-internal types — keep this in sync with the dataclasses.

export interface McptStep {
  real_objective: number
  permutation_objectives: number[]
  quasi_p: number
  n_permutations: number
  threshold: number
  passed: boolean
}

export interface GridResult { params: Record<string, number>; objective: number | null }

export interface Step1Fit {
  best_params: Record<string, number>
  objective: number
  equity: number[]
  grid_results: GridResult[]
}

export interface Fold {
  train_range_ms: [number, number]
  test_range_ms: [number, number]
  params: Record<string, number>
  oos_objective: number
  oos_equity: number[]
}

export interface Step3WalkForward {
  folds: Fold[]
  oos_objective: number
  oos_equity: number[]
  oos_periods: number
  embargo_days: number
}

export interface BenchmarkOverlay {
  benchmark: string
  periods: number
  strategy_total_return: number
  benchmark_total_return: number
  excess_total_return: number
  alpha_annual: number
  beta: number
  information_ratio: number
  beats_market: boolean
}

export interface LegacyGates {
  mean_ic: number
  ic_pvalue: number
  ic_hit_rate: number
  oos_sharpe: number
  max_drawdown: number
  cvar_95: number
  deflated_sharpe: number
  pbo: number
  fdr_corrected_pvalue: number
  passed: boolean
  failures: string[]
}

export interface ValidationReportV2 {
  strategy_id: string
  objective_name: string
  engine: string
  data_window_ms: [number, number]
  train_window_ms: [number, number]
  universe_size_at_run: number
  data_source: string
  data_quality: string
  rebalance_days: number
  step1_in_sample_fit: Step1Fit
  step2_in_sample_mcpt: McptStep
  step3_walk_forward: Step3WalkForward
  step4_walk_forward_mcpt: McptStep
  benchmark_overlays: BenchmarkOverlay[]
  legacy_gates: LegacyGates
  passed: boolean
  failures: string[]
  context_notes: string[]
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface ValidationJob {
  _id: string
  strategy_id: string
  status: JobStatus
  request?: Record<string, unknown>
  report?: ValidationReportV2
  error?: string
  createdAt?: string
  claimedAt?: string
  completedAt?: string
  failedAt?: string
}

export function pct(x: number | undefined): string {
  return x === undefined || x === null ? '—' : `${(x * 100).toFixed(1)}%`
}

// Masters: a quasi-p of 0 is an upper bound, not a literal zero — render `< 1/n`.
export function quasiPLabel(step: McptStep): string {
  if (step.quasi_p <= 0) return `< ${(1 / Math.max(step.n_permutations, 1)).toFixed(3)}`
  return step.quasi_p.toFixed(3)
}
