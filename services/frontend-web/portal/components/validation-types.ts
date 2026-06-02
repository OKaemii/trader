// Local mirror of backtest-engine's job documents + report shapes
// (services/backtest-engine/src/application/{validator,backtest_run,job_runner}.py + src/main.py).
// Per the portal convention we don't import service-internal types — keep this in sync.

export type JobKind = 'mcpt' | 'backtest'
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface McptStep {
  real_objective: number
  permutation_objectives: number[]
  quasi_p: number
  n_permutations: number
  threshold: number
  passed: boolean
  early_stopped?: boolean        // stopped once the verdict was decision-locked
  n_planned?: number             // requested N (n_permutations is what actually ran)
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

export interface PermutationSeed {
  engine: string
  base: number
  wf_offset: number
  n_in_sample: number
  n_wf: number
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
  permutation_seed?: PermutationSeed
  passed: boolean
  failures: string[]
  context_notes: string[]
}

// Mirror of the backtest job's report dict (backtest_run.run_backtest_job).
export interface BacktestReport {
  strategy_id: string
  engine: string
  passed: boolean
  failures: string[]
  context_notes?: string[]
  oos_sharpe: number
  mean_ic: number
  ic_hit_rate?: number
  deflated_sharpe: number
  pbo: number
  fdr_corrected_pvalue: number
  max_drawdown?: number
  cvar_95?: number
  n_trials?: number
  benchmark?: BenchmarkOverlay | null
  ablation_variants_tested: string[]
  data_source?: string
  universe_size?: number
  seed?: number
  diagnostics?: Record<string, number>
  completed_at?: string
}

export interface JobProgress {
  stage: string
  pct: number
  completed_units: number
  total_units: number
  eta_ms: number | null
  started_at: number
  updated_at: number
}

export interface JobSummary {
  passed: boolean
  early_stopped: boolean
  n_done?: number
  n_planned?: number
}

export interface ValidationJob {
  _id: string
  kind?: JobKind
  strategy_id: string
  status: JobStatus
  seed?: number
  request?: Record<string, unknown>
  progress?: JobProgress
  summary?: JobSummary
  report?: ValidationReportV2 | BacktestReport
  error?: string
  createdAt?: string
  claimedAt?: string
  completedAt?: string
  failedAt?: string
  cancelledAt?: string
}

// Ordered stage steppers per kind — the backend `set_stage` labels, with the long pole flagged.
export interface StageStep { key: string; label: string; long?: boolean }
export const MCPT_STAGES: StageStep[] = [
  { key: 'in_sample_fit', label: 'IS fit' },
  { key: 'in_sample_mcpt', label: 'IS-MCPT' },
  { key: 'walk_forward', label: 'Walk-fwd' },
  { key: 'walk_forward_mcpt', label: 'WF-MCPT', long: true },
]
export const BACKTEST_STAGES: StageStep[] = [
  { key: 'in_sample_fit', label: 'IS fits', long: true },
  { key: 'out_of_sample', label: 'OOS', long: true },
  { key: 'scoring', label: 'Scoring' },
]
export function stagesFor(kind?: JobKind): StageStep[] {
  return kind === 'backtest' ? BACKTEST_STAGES : MCPT_STAGES
}

export function pct(x: number | undefined): string {
  return x === undefined || x === null ? '—' : `${(x * 100).toFixed(1)}%`
}

// Masters: a quasi-p of 0 is an upper bound, not a literal zero — render `< 1/n`.
export function quasiPLabel(step: McptStep): string {
  if (step.early_stopped) return `≥ ${step.quasi_p.toFixed(3)}`   // fail-locked lower bound
  if (step.quasi_p <= 0) return `< ${(1 / Math.max(step.n_permutations, 1)).toFixed(3)}`
  return step.quasi_p.toFixed(3)
}

// Humanise an ETA in ms → "~3m 20s" / "~1h 4m" / "—" (null/negative).
export function etaLabel(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `~${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `~${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `~${h}h ${m % 60}m`
}
