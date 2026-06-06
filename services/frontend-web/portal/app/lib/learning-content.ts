// Pure content registry for the contextual learning layer (Task 5 of the portal-IA
// redesign — agent-docs/plans/portal-ia-redesign.md). No React, no DOM, no side
// effects: just the metric copy + interpretation bands + a pure band picker, so it
// is trivially unit-testable (relative-imported by the vitest, which does NOT resolve
// the `@/` alias) and importable from both the client <Explain>/<Metric> components
// and any future server caller.
//
// ADDITIVE / DORMANT in this card: nothing here is wired into a real page yet.
// Card #15 (Beginner/Quant wiring) threads <Metric>/<Explain> into the live metric
// displays (Performance KPIs, Positions R-multiple, Signals factor exposure, Research
// PBO/DSR). This card only ships the API.

/**
 * One interpretation band. `max` is the *inclusive upper bound* of the band — a value
 * is in the first band (ascending by `max`) for which `value <= max`. `tone` drives the
 * colour/emphasis the UI applies to the band `label`.
 */
export type Band = {
  max: number
  label: string
  tone: 'bad' | 'weak' | 'good' | 'strong'
}

/**
 * A metric the learning layer can explain.
 * - `bands` MUST be sorted ascending by `max`. Open-ended (higher-is-allowed) metrics
 *   end their final band at `Infinity` so any finite value lands somewhere; genuinely
 *   bounded metrics (e.g. RSI ∈ [0,100]) cap their final `max` at the domain edge, so a
 *   value past it is reported as unknown (interpret → null) rather than mislabelled.
 * - `fmt` (optional) renders the raw number for display (e.g. a percent). When absent the
 *   consumer falls back to a plain string. Kept pure so the popover and <Metric> agree.
 */
export type Metric = {
  id: string
  title: string
  summary: string
  bands: Band[]
  fmt?: (n: number) => string
}

// Shared display formatters. Defined once so every percent-style metric renders the same
// way and the registry stays declarative.
const pct = (dp = 1) => (n: number) => `${(n * 100).toFixed(dp)}%`
const ratio = (dp = 2) => (n: number) => n.toFixed(dp)

/**
 * The seed registry, keyed by metric id. ~10 metrics spanning the surfaces the redesign
 * wires later: portfolio KPIs (sharpe, sortino, maxDrawdown, volatility, winRate), a
 * per-trade quality measure (rMultiple), a momentum oscillator (rsi), a factor tilt
 * (factorExposure), and two backtest-validation gates (pbo, dsr).
 *
 * Band direction is per-metric: higher-is-better (sharpe, sortino, rMultiple, dsr,
 * winRate), lower-is-better (maxDrawdown, volatility, pbo), or central-is-normal
 * (rsi, factorExposure). The ascending-`max` + first-match rule in interpret() handles
 * all three uniformly.
 */
export const METRICS: Record<string, Metric> = {
  sharpe: {
    id: 'sharpe',
    title: 'Sharpe Ratio',
    summary: 'Annualised return per unit of total volatility. Higher is better; ~1 is decent, ~2 is strong.',
    fmt: ratio(2),
    bands: [
      { max: 1, label: 'weak', tone: 'weak' },
      { max: 2, label: 'good', tone: 'good' },
      { max: Infinity, label: 'strong', tone: 'strong' },
    ],
  },
  sortino: {
    id: 'sortino',
    title: 'Sortino Ratio',
    summary: 'Return per unit of downside (harmful) volatility only. Runs a touch higher than Sharpe; >2.5 is strong.',
    fmt: ratio(2),
    bands: [
      { max: 1.5, label: 'weak', tone: 'weak' },
      { max: 2.5, label: 'good', tone: 'good' },
      { max: Infinity, label: 'strong', tone: 'strong' },
    ],
  },
  maxDrawdown: {
    id: 'maxDrawdown',
    title: 'Max Drawdown',
    summary: 'Largest peak-to-trough equity decline, as a positive fraction. Smaller is better.',
    fmt: pct(1),
    bands: [
      { max: 0.1, label: 'shallow', tone: 'strong' },
      { max: 0.2, label: 'moderate', tone: 'good' },
      { max: 0.35, label: 'deep', tone: 'weak' },
      { max: Infinity, label: 'severe', tone: 'bad' },
    ],
  },
  volatility: {
    id: 'volatility',
    title: 'Volatility',
    summary: 'Annualised standard deviation of returns. Lower is calmer; the book targets ~10%.',
    fmt: pct(1),
    bands: [
      { max: 0.1, label: 'low', tone: 'strong' },
      { max: 0.2, label: 'moderate', tone: 'good' },
      { max: 0.3, label: 'elevated', tone: 'weak' },
      { max: Infinity, label: 'high', tone: 'bad' },
    ],
  },
  rMultiple: {
    id: 'rMultiple',
    title: 'R-Multiple',
    summary: 'Trade profit/loss expressed in units of the risk taken. Above 1R beats the risk budget.',
    fmt: ratio(2),
    bands: [
      { max: 0, label: 'loss', tone: 'bad' },
      { max: 1, label: 'sub-1R', tone: 'weak' },
      { max: 2, label: 'solid', tone: 'good' },
      { max: Infinity, label: 'strong', tone: 'strong' },
    ],
  },
  rsi: {
    id: 'rsi',
    title: 'RSI (14)',
    summary: 'Relative Strength Index, 0–100. Below 30 is oversold, above 70 overbought; the middle is neutral.',
    fmt: ratio(0),
    // Bounded ∈ [0,100]: the final band caps at 100, so a value past the domain
    // resolves to null (unknown) rather than being mislabelled.
    bands: [
      { max: 30, label: 'oversold', tone: 'weak' },
      { max: 70, label: 'neutral', tone: 'good' },
      { max: 100, label: 'overbought', tone: 'weak' },
    ],
  },
  factorExposure: {
    id: 'factorExposure',
    title: 'Factor Exposure',
    summary: 'Sensitivity (beta) of the position to a risk factor. Near zero is neutral; large magnitudes are concentrated bets.',
    fmt: ratio(2),
    bands: [
      { max: -0.5, label: 'strong negative', tone: 'weak' },
      { max: 0.5, label: 'neutral', tone: 'good' },
      { max: 1.5, label: 'tilted', tone: 'good' },
      { max: Infinity, label: 'concentrated', tone: 'weak' },
    ],
  },
  pbo: {
    id: 'pbo',
    title: 'PBO',
    summary: 'Probability of Backtest Overfitting (CSCV), 0–1. Lower is better; above 50% means the edge is likely spurious.',
    fmt: pct(0),
    bands: [
      { max: 0.1, label: 'low', tone: 'strong' },
      { max: 0.5, label: 'moderate', tone: 'good' },
      { max: Infinity, label: 'high', tone: 'bad' },
    ],
  },
  dsr: {
    id: 'dsr',
    title: 'Deflated Sharpe',
    summary: 'Deflated Sharpe Ratio — probability the true Sharpe exceeds zero after multiple-testing correction. Higher is better.',
    fmt: pct(0),
    bands: [
      { max: 0.5, label: 'inconclusive', tone: 'weak' },
      { max: 0.95, label: 'likely', tone: 'good' },
      { max: Infinity, label: 'significant', tone: 'strong' },
    ],
  },
  winRate: {
    id: 'winRate',
    title: 'Win Rate',
    summary: 'Share of trades that closed profitably, 0–1. Read alongside R-multiple — a low win rate can still pay if winners are large.',
    fmt: pct(0),
    bands: [
      { max: 0.4, label: 'low', tone: 'weak' },
      { max: 0.55, label: 'balanced', tone: 'good' },
      { max: Infinity, label: 'high', tone: 'strong' },
    ],
  },
}

/**
 * Pure band selector.
 *
 * Returns the first band (ascending by `max`) whose inclusive upper bound the value does
 * not exceed — i.e. the lowest band with `value <= band.max`. Returns `null` when:
 * - the `id` is not in the registry (unknown metric), or
 * - the value matches no band: a non-finite value (NaN/±Infinity against a bounded metric)
 *   or a value beyond a bounded metric's domain (e.g. RSI > 100).
 *
 * The lowest band catches arbitrarily-low values (a negative Sharpe lands in the weakest
 * band), and an Infinity-capped final band catches arbitrarily-high ones — so for
 * open-ended metrics only an unknown id or NaN yields null.
 */
export function interpret(id: string, value: number): Band | null {
  const metric = METRICS[id]
  if (!metric) return null
  for (const band of metric.bands) {
    if (value <= band.max) return band
  }
  return null
}
