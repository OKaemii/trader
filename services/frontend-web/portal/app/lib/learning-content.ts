// Pure content registry for the contextual learning layer (Task 5 of the portal-IA
// redesign — agent-docs/plans/portal-ia-redesign.md). No React, no DOM, no side
// effects: just the metric copy + interpretation bands + a pure band picker, so it
// is trivially unit-testable (relative-imported by the vitest, which does NOT resolve
// the `@/` alias) and importable from both the client <Explain>/<Metric> components
// and any future server caller.
//
// Task 32 (research-trading-os §F — progressive disclosure) broadens this in two ways:
//  - each metric can carry up to three depths (summary → key factors → full detail) that
//    <Explain> steps through under user control, and
//  - the registry gains the research metrics surfaced across this epic (factor percentile
//    and the per-factor z-scores, inclusion/contribution attribution, breadth, HHI).
// The registry stays the single source of truth — learning scales by adding an entry here,
// never by special-casing a page. Every metric still maps a stable id to title + bands.

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
 *
 * Progressive disclosure (Task 32 — research-trading-os §F): a metric carries up to THREE
 * depths the <Explain> toggletip steps through under user control. The ladder is additive —
 * a metric supplies whatever it has and the UI only offers the deeper rungs that exist:
 * - depth 0 (`summary`) — the one-line plain-English gist. Always present.
 * - depth 1 (`factors`) — the "key factors": a short bulleted list of the inputs/drivers
 *   that move the number. Optional; omit on metrics with nothing useful to itemise.
 * - depth 2 (`detail`) — the "full detail" prose: the precise definition, how to read it
 *   against the bands, and the caveat that matters. Optional.
 * Quant mode only *adds* depth — it never gates a safety control; these are explanatory
 * copy, so showing more of it is always safe.
 */
export type Metric = {
  id: string
  title: string
  summary: string
  bands: Band[]
  fmt?: (n: number) => string
  /** Depth 1 — "key factors": the handful of drivers that move this number. */
  factors?: string[]
  /** Depth 2 — "full detail": the precise definition + how to read it + the caveat. */
  detail?: string
}

/**
 * The disclosure depths, deepest-last. `Explain` steps a cursor through the prefix of this
 * list a given metric actually populates (depth 0 is always available). Exported so the
 * component and its test share one definition of the ladder rather than re-deriving it.
 */
export const DEPTHS = ['summary', 'factors', 'detail'] as const
export type Depth = (typeof DEPTHS)[number]

/**
 * The deepest depth index (0..2) a metric supports: the highest index whose layer is
 * populated. `summary` is mandatory, so this is at least 0. Pure — it drives the
 * toggletip's "more/less" affordance without the component reaching into the registry
 * shape itself. Unknown id ⇒ 0 (mirrors interpret()/Explain degrading silently).
 */
export function maxDepth(id: string): number {
  const metric = METRICS[id]
  if (!metric) return 0
  if (metric.detail) return 2
  if (metric.factors && metric.factors.length > 0) return 1
  return 0
}

// Shared display formatters. Defined once so every percent-style metric renders the same
// way and the registry stays declarative.
const pct = (dp = 1) => (n: number) => `${(n * 100).toFixed(dp)}%`
const ratio = (dp = 2) => (n: number) => n.toFixed(dp)

/**
 * The registry, keyed by metric id. Two families:
 * - Portfolio / validation KPIs (the original seed): sharpe, sortino, maxDrawdown,
 *   volatility, winRate, rMultiple, rsi, factorExposure, pbo, dsr.
 * - Research metrics surfaced across this epic (Task 32 §F): the cross-sectional factor
 *   scores (factorPercentile, momentum, quality, value, volatilityFactor), the attribution
 *   pair (inclusion, contribution), and the internals/concentration gauges (breadth, hhi).
 *
 * Band direction is per-metric: higher-is-better (sharpe, sortino, rMultiple, dsr, winRate,
 * factorPercentile, the factor z-scores, breadth), lower-is-better (maxDrawdown, volatility,
 * pbo, hhi, inclusion), or central/signed (rsi, factorExposure, contribution). The
 * ascending-`max` + first-match rule in interpret() handles all of them uniformly, and the
 * optional `factors`/`detail` layers give <Explain> its deeper rungs without touching it.
 */
export const METRICS: Record<string, Metric> = {
  sharpe: {
    id: 'sharpe',
    title: 'Sharpe Ratio',
    summary: 'Annualised return per unit of total volatility. Higher is better; ~1 is decent, ~2 is strong.',
    fmt: ratio(2),
    factors: [
      'Average return above the risk-free rate (the numerator).',
      'Total return volatility — up and down swings alike (the denominator).',
      'The annualisation cadence: it scales with √periods, so the bar frequency matters.',
    ],
    detail:
      'Sharpe = (mean excess return) ÷ (standard deviation of returns), annualised. Because the denominator counts both up and down moves, a strategy that is volatile but profitable can still show a modest Sharpe. It says nothing about tail risk — pair it with max drawdown and the deflated Sharpe (DSR), which corrects for how many configurations were tried.',
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
    factors: [
      'Average return above the target (the numerator, as for Sharpe).',
      'Downside deviation only — upside swings are excluded from the denominator.',
    ],
    detail:
      'Sortino replaces Sharpe\'s total-volatility denominator with the downside deviation (the spread of returns below the target return). It rewards strategies whose volatility is mostly to the upside, so it usually reads higher than the same strategy\'s Sharpe. A large Sortino-minus-Sharpe gap signals an asymmetric, positively-skewed return profile.',
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
    factors: [
      'The highest equity peak reached (the high-water mark).',
      'The lowest trough after that peak, before a new peak is set.',
      'Position concentration — a few large names deepen the worst case.',
    ],
    detail:
      'Max drawdown is the worst peak-to-trough fall in cumulative equity over the window, reported as a positive fraction. It is the headline pain metric: the circuit breaker halts trading on a live drawdown past its threshold. Unlike volatility it is path-dependent and backward-looking — it tells you the deepest hole this history dug, not the deepest one possible.',
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
    factors: [
      'The dispersion of period returns around their mean.',
      'The annualisation factor (√periods for the bar frequency in use).',
      'Cross-position correlation — diversified names damp portfolio volatility.',
    ],
    detail:
      'Volatility is the annualised standard deviation of portfolio returns. The risk engine scales position weights to hold realised volatility near the VOL_TARGET (≈10%). It is symmetric — it penalises upside and downside moves equally — which is why downside-only Sortino and the path-dependent max drawdown are read alongside it.',
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
    factors: [
      'The realised P&L on the trade (the numerator).',
      'The initial risk — entry minus the stop, in price terms (the 1R denominator).',
    ],
    detail:
      'R-multiple normalises every trade to the risk it put on: a +2R win made twice what it risked, a −1R loss gave back exactly the budgeted risk. It makes trades of different sizes comparable and lets a strategy with a sub-50% win rate still be profitable if its winners run several R. Read it with win rate, not instead of it.',
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
    factors: [
      'Average size of up-closes over the 14-bar window.',
      'Average size of down-closes over the same window.',
      'The bar frequency: RSI on daily bars and on 5m bars are different signals.',
    ],
    detail:
      'RSI = 100 − 100 ÷ (1 + average gain ÷ average loss) over the last 14 bars, bounded to [0,100]. It is a momentum oscillator, not a price target: an oversold reading flags a stretched move, not a guaranteed bounce, and a strong trend can sit above 70 for a long time. A value past the [0,100] domain reads as unknown rather than being mislabelled.',
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
    factors: [
      'The regression beta of the position\'s returns onto the factor\'s returns.',
      'The sign — positive means it moves with the factor, negative against it.',
      'The magnitude — far from zero is a concentrated bet on that factor.',
    ],
    detail:
      'Factor exposure is the beta from regressing the position (or book) onto a risk factor such as momentum or value. Zero is factor-neutral; ±1 moves one-for-one with the factor. It is descriptive, not directional — a large exposure is only good if you intend that tilt. Watch the aggregate: many small tilts can compound into one concentrated factor bet across the book.',
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
    factors: [
      'How often the in-sample-best configuration underperforms out-of-sample.',
      'The number of configurations tried — more trials inflate overfitting risk.',
      'The combinatorial CSCV split count, which sets the resolution of the estimate.',
    ],
    detail:
      'PBO (Combinatorially-Symmetric Cross-Validation) estimates the probability that the configuration you picked because it looked best in-sample actually ranks below the median out-of-sample. Above 50% your selection is no better than a coin flip — the apparent edge is likely a backtest artefact. It is the headline honesty gate: a low PBO informs, but does not by itself open, the live-trading decision.',
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
    factors: [
      'The observed Sharpe ratio and its sampling error.',
      'The number of trials — the more strategies tested, the higher the bar.',
      'Return skew and kurtosis, which bias a naive Sharpe.',
    ],
    detail:
      'The Deflated Sharpe Ratio returns the probability the true Sharpe is above zero after correcting for how many configurations were tried and for non-normal returns. Testing many strategies guarantees some look good by luck; DSR deflates the best observed Sharpe by that selection effect. Near 1 the edge survives multiple-testing scrutiny; near 0.5 it is inconclusive.',
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
    factors: [
      'The count of profitable closed trades.',
      'The total count of closed trades (the denominator).',
      'The average R of winners vs losers — win rate alone hides this.',
    ],
    detail:
      'Win rate is simply winners ÷ total closed trades. On its own it is misleading: a trend strategy can win under 40% of the time and still compound if its winners run several R while losers are cut at −1R. Always read it next to the R-multiple distribution — the two together describe the edge, neither does alone.',
    bands: [
      { max: 0.4, label: 'low', tone: 'weak' },
      { max: 0.55, label: 'balanced', tone: 'good' },
      { max: Infinity, label: 'high', tone: 'strong' },
    ],
  },

  // ── Research metrics surfaced across this epic (Task 32 §F) ──────────────────
  // Factor scoring is cross-sectional: each name is z-scored within the candidate
  // universe, so the readable surface is a percentile (0–1) or a z-score (≈ −3..+3).
  factorPercentile: {
    id: 'factorPercentile',
    title: 'Factor Percentile',
    summary: 'Where this name ranks on the blended factor score within the universe, 0–1. Higher means a stronger overall tilt.',
    fmt: pct(0),
    factors: [
      'The blended cross-sectional factor score (momentum, quality, value, low-vol).',
      'The size of the candidate universe it is ranked against.',
      'The strategy\'s factor weights — they decide what "strong" means here.',
    ],
    detail:
      'The factor percentile is the name\'s rank on the strategy\'s composite factor score, expressed as a fraction of the universe (1.0 = top of the book). Because ranking is cross-sectional and scale-invariant, it is comparable across names regardless of price or currency. Top-K selection draws from the high end of this distribution; a name near 0.5 is mid-pack and unlikely to be held.',
    bands: [
      { max: 0.4, label: 'low', tone: 'weak' },
      { max: 0.7, label: 'mid-pack', tone: 'good' },
      { max: 0.9, label: 'high', tone: 'good' },
      { max: 1, label: 'top', tone: 'strong' },
    ],
  },
  momentum: {
    id: 'momentum',
    title: 'Momentum (z)',
    summary: 'Cross-sectional momentum score as a z-score. Positive leads the universe; ~0 is average; negative lags.',
    fmt: ratio(2),
    factors: [
      'The 12-1 return — trailing ~12 months excluding the most recent month.',
      'The skip month, which strips out short-term mean reversion.',
      'The universe mean and spread the raw return is z-scored against.',
    ],
    detail:
      'Momentum here is the classic 12-1 measure: cumulative return over roughly the last year, skipping the most recent month to avoid short-term reversal, then z-scored across the universe. A z of +1 sits one standard deviation above the universe mean. It is dimensionless (a log-return ratio), so currency and price level do not enter — only relative trend strength does.',
    bands: [
      { max: -1, label: 'lagging', tone: 'weak' },
      { max: 0.5, label: 'average', tone: 'good' },
      { max: 1.5, label: 'leading', tone: 'good' },
      { max: Infinity, label: 'strong', tone: 'strong' },
    ],
  },
  quality: {
    id: 'quality',
    title: 'Quality (z)',
    summary: 'Quality-minus-junk score as a z-score: profitable, low-leverage, solvent names score higher.',
    fmt: ratio(2),
    factors: [
      'Return on equity — profitability (the QMJ floor is ROE ≥ 0.10).',
      'Debt/equity — leverage (the screen caps it at ≤ 2.0).',
      'Current ratio — short-term solvency (the screen floors it at ≥ 1.0).',
    ],
    detail:
      'Quality blends profitability, leverage, and solvency into one cross-sectional z-score, aligned with the fail-closed QMJ screen (ROE ≥ 0.10 ∧ D/E ≤ 2.0 ∧ Current ≥ 1.0; a missing or zero denominator fails). A high score flags a financially sturdy business; a negative one flags weak or leveraged fundamentals. Quality is slow-moving — it reranks on the monthly fundamentals refresh, not every bar.',
    bands: [
      { max: -1, label: 'weak', tone: 'weak' },
      { max: 0.5, label: 'average', tone: 'good' },
      { max: 1.5, label: 'solid', tone: 'good' },
      { max: Infinity, label: 'high', tone: 'strong' },
    ],
  },
  value: {
    id: 'value',
    title: 'Value (z)',
    summary: 'Cheapness score as a z-score: higher means the name looks inexpensive vs the universe on valuation multiples.',
    fmt: ratio(2),
    factors: [
      'Valuation multiples (earnings/book/cash-flow yield) vs the universe.',
      'The sign convention — cheap names are flipped to score positive.',
      'Sector composition, since multiples differ structurally by sector.',
    ],
    detail:
      'Value is a cross-sectional z-score of cheapness: yields/multiples normalised so an inexpensive name scores positive and a richly-priced one negative. It is the classic counterweight to momentum — the two are often negatively correlated, so a blend diversifies the factor bet. Cheap can stay cheap (a value trap), which is why value is screened alongside quality rather than used alone.',
    bands: [
      { max: -1, label: 'expensive', tone: 'weak' },
      { max: 0.5, label: 'fair', tone: 'good' },
      { max: 1.5, label: 'cheap', tone: 'good' },
      { max: Infinity, label: 'deep value', tone: 'strong' },
    ],
  },
  volatilityFactor: {
    id: 'volatilityFactor',
    title: 'Low-Volatility (z)',
    summary: 'Low-volatility factor score as a z-score: calmer names score higher (the sign is flipped so high = low risk).',
    fmt: ratio(2),
    factors: [
      'Trailing realised volatility of the name\'s returns.',
      'The sign flip — low raw volatility maps to a high factor score.',
      'The lookback window the volatility is measured over.',
    ],
    detail:
      'The low-volatility factor z-scores trailing realised volatility and flips the sign, so a calm, low-variance name scores high and a jumpy one scores low. It captures the low-volatility anomaly (low-risk names have historically earned competitive returns). Distinct from portfolio "Volatility": this ranks a single name cross-sectionally; that one measures the whole book\'s annualised risk.',
    bands: [
      { max: -1, label: 'high-vol', tone: 'weak' },
      { max: 0.5, label: 'average', tone: 'good' },
      { max: 1.5, label: 'calm', tone: 'good' },
      { max: Infinity, label: 'very calm', tone: 'strong' },
    ],
  },
  inclusion: {
    id: 'inclusion',
    title: 'Inclusion %',
    summary: 'Share of the candidate universe that survives the screens into the held set, 0–1. A narrow funnel is more selective.',
    fmt: pct(0),
    factors: [
      'The candidate universe size (the screening pool).',
      'How many names clear the QMJ/momentum/liquidity screens.',
      'Top-K, which trims survivors to the final held count.',
    ],
    detail:
      'Inclusion is held names ÷ candidate universe — the funnel\'s overall pass rate. A low percentage means the screens are doing real work (concentrating into high-conviction names); a high one means little is being filtered. Read it on the pipeline funnel alongside each stage\'s drop: a single stage rejecting almost everything can signal a mis-tuned threshold rather than genuine selectivity.',
    bands: [
      { max: 0.05, label: 'very narrow', tone: 'strong' },
      { max: 0.2, label: 'selective', tone: 'good' },
      { max: 0.5, label: 'broad', tone: 'good' },
      { max: 1, label: 'permissive', tone: 'weak' },
    ],
  },
  contribution: {
    id: 'contribution',
    title: 'Contribution %',
    summary: 'This name or factor\'s share of total return, as a signed fraction. Large magnitudes drove the result.',
    fmt: pct(1),
    factors: [
      'The position weight over the period.',
      'The return earned on that position.',
      'The total portfolio return the share is taken against (the denominator).',
    ],
    detail:
      'Contribution attributes the portfolio\'s return to its parts: weight × return for a name (or summed across a factor/sector), divided by the total return. It is signed — a detractor shows negative — and the contributions sum to 100% of the result. It explains what drove performance, not whether the bet was good: a large positive contribution from one concentrated name is also a concentration risk worth checking against HHI.',
    bands: [
      { max: -0.1, label: 'detractor', tone: 'bad' },
      { max: 0, label: 'slight drag', tone: 'weak' },
      { max: 0.1, label: 'contributor', tone: 'good' },
      { max: Infinity, label: 'major driver', tone: 'strong' },
    ],
  },
  breadth: {
    id: 'breadth',
    title: 'Breadth',
    summary: 'Share of the universe trending up — a market-internals gauge, 0–1. High breadth = a broad-based advance.',
    fmt: pct(0),
    factors: [
      'How many names sit above their trend filter (e.g. their moving average).',
      'The size of the universe measured.',
      'The trend definition used as the up/down threshold.',
    ],
    detail:
      'Breadth is the fraction of the universe in an uptrend (above its trend filter). It is a market-internals read the defensive overlay uses: a rally on narrow breadth — a few mega-caps masking a weak majority — is fragile, while broad breadth confirms a healthy advance. Low breadth can flip the absolute-momentum overlay defensive even when the index itself still looks fine.',
    bands: [
      { max: 0.3, label: 'narrow', tone: 'bad' },
      { max: 0.5, label: 'mixed', tone: 'weak' },
      { max: 0.7, label: 'healthy', tone: 'good' },
      { max: 1, label: 'broad', tone: 'strong' },
    ],
  },
  hhi: {
    id: 'hhi',
    title: 'Concentration (HHI)',
    summary: 'Herfindahl–Hirschman index of position weights, 0–1. Lower is more diversified; higher is concentrated.',
    fmt: ratio(3),
    factors: [
      'Each position\'s portfolio weight, squared.',
      'The number of held positions — the floor HHI is 1 ÷ N.',
      'How unevenly weight is spread across those positions.',
    ],
    detail:
      'HHI is the sum of squared position weights. An equal-weight book of N names sits at its floor of 1/N; weight piled into a few names pushes it toward 1.0. It is the headline concentration gauge — the optimiser\'s single-name and sector caps exist to keep it sane, and the regime engine watches it. Read it with Contribution %: a high HHI plus one name driving most of the return is a single point of failure.',
    bands: [
      { max: 0.1, label: 'diversified', tone: 'strong' },
      { max: 0.2, label: 'balanced', tone: 'good' },
      { max: 0.4, label: 'concentrated', tone: 'weak' },
      { max: 1, label: 'top-heavy', tone: 'bad' },
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
