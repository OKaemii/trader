// research-backfill-core — the pure, I/O-free logic of the research-backfill migration
// (infra/migrations/2026-06-07-research-backfill.ts). Split out so the gap math, the
// cross-sectional factor math, the per-factor source-stamping, and the idempotency /
// fill-missing decisions are unit-testable WITHOUT live Mongo / EODHD — exactly the
// "parts testable without live infra" the card scopes.
//
// Why this code is mirrored rather than imported: an infra migration runs via bare
// `pnpm tsx` with only the `mongodb` driver on its path (see the sibling
// 2026-05-15 / 2026-05-23 migrations, which inline-mirror `hashBarContent` the same
// way). It must not pull a built workspace package (`@trader/shared-bars` exports only
// from dist and drags in pg/redis). So the canonical algorithms below are mirrored from
// their single sources of truth and MUST be kept in lockstep with them:
//
//   - computeMissingRanges      <- packages/shared-bars/src/coverage.ts
//   - momentum / volatility raw <- packages/quant-core/quant_core/research_factors.py
//                                  (_price_factors) + strategy/collaborators/scorer.py
//                                  (eligible_returns)
//   - crossSectionalZScores     <- research_factors.py (_price_zscores)
//   - percentiles               <- research_factors.py (_percentiles, Hazen midrank)
//   - dividendYieldAsOf         <- services/.../corporate-actions/application/dividend-yield.ts
//   - buildFactorBlock sources  <- services/strategy-engine/src/infrastructure/factor_store.py
//                                  (stamp_factor_sources / build_docs)
//   - buildHeldSetSnapshots     <- services/.../signals/application/HeldSetSnapshot.ts
//
// Any divergence here silently disagrees with the live host about what a factor IS, so
// the lockstep comments above are load-bearing.

export const DAY_MS = 24 * 60 * 60 * 1000;

// -- Gap math (mirror of shared-bars computeMissingRanges) ------------------------------

/** A grid-inclusive uncovered span: `start`/`end` are step-aligned observation_ts (ms). */
export interface MissingRange {
  start: number;
  end: number;
}

/**
 * Uncovered sub-ranges of `[neededStart, neededEnd]` given the observation timestamps we
 * already hold (`existing`), on a fixed `stepMs` grid. A grid point is covered when some
 * held observation lands in its `[point, point + stepMs)` bucket. Contiguous uncovered
 * points collapse into one range. Full coverage -> []; empty `existing` -> the whole span.
 *
 * Bucket-based (not exact equality) so it tolerates the small drift between a daily bar's
 * stamp and the 00:00:00Z grid anchor — exactly as the shared-bars original. Pure.
 */
export function computeMissingRanges(
  existing: readonly number[],
  neededStart: number,
  neededEnd: number,
  stepMs: number,
): MissingRange[] {
  if (stepMs <= 0) throw new Error('[research-backfill] computeMissingRanges: stepMs must be > 0');
  if (neededEnd < neededStart) return [];

  const held = Array.from(existing).sort((a, b) => a - b);

  const out: MissingRange[] = [];
  let runStart: number | null = null;
  let prevPoint = neededStart;
  let heldIdx = 0;

  for (let point = neededStart; point <= neededEnd; point += stepMs) {
    const bucketEnd = point + stepMs;
    while (heldIdx < held.length && held[heldIdx]! < point) heldIdx++;
    const covered = heldIdx < held.length && held[heldIdx]! < bucketEnd;

    if (covered) {
      if (runStart !== null) {
        out.push({ start: runStart, end: prevPoint });
        runStart = null;
      }
    } else if (runStart === null) {
      runStart = point;
    }
    prevPoint = point;
  }

  if (runStart !== null) out.push({ start: runStart, end: prevPoint });
  return out;
}

/** Floor `ms` to UTC midnight (the daily bar-stamp convention) — the grid anchor for the daily series. */
export function floorToUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * The set of daily observation dates (UTC-midnight ms) the backfill should WRITE a
 * factor_scores row for, given the dates we already have a row for. This is the §I
 * gap-aware fetch/write planner specialised to the research backfill's own output:
 *
 *  - `force`: every grid date in `[startDay, endDay]` (re-compute the whole span).
 *  - otherwise: every grid date NOT already covered by `existingScoreDays` — the
 *    idempotent-per-(ticker, observation_ts) skip. A second run over a fully-populated
 *    span returns [] (writes ~nothing), which is the "second run fetches/writes ~nothing"
 *    done-criterion.
 *
 * Both bounds are floored to the UTC-day grid so the points coincide with bar stamps.
 */
export function planScoreDays(
  existingScoreDays: readonly number[],
  startMs: number,
  endMs: number,
  force: boolean,
): number[] {
  const startDay = floorToUtcDay(startMs);
  const endDay = floorToUtcDay(endMs);
  if (endDay < startDay) return [];

  if (force) {
    const all: number[] = [];
    for (let d = startDay; d <= endDay; d += DAY_MS) all.push(d);
    return all;
  }

  const gaps = computeMissingRanges(existingScoreDays, startDay, endDay, DAY_MS);
  const out: number[] = [];
  for (const g of gaps) for (let d = g.start; d <= g.end; d += DAY_MS) out.push(d);
  return out;
}

// -- Cross-sectional stats (mirror of research_factors _price_zscores / _percentiles) ---

/**
 * Cross-sectional z-score over the finite entries (NaN in -> NaN out). Distinct from a
 * zero-fill: a flat-but-finite cross-section z-scores to all-0.0 (real, rankable), but a
 * sub-2 finite set has no dispersion to score on and stays NaN -> those names emit null.
 * Population std (ddof=0), matching numpy's `ndarray.std()` in research_factors.py.
 */
export function crossSectionalZScores(raw: readonly number[]): number[] {
  const out = raw.map(() => NaN);
  const finiteIdx: number[] = [];
  for (let i = 0; i < raw.length; i++) if (Number.isFinite(raw[i]!)) finiteIdx.push(i);
  if (finiteIdx.length < 2) return out;

  const vals = finiteIdx.map((i) => raw[i]!);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length;
  const std = Math.sqrt(variance);
  for (const i of finiteIdx) out[i] = std <= 1e-8 ? 0.0 : (raw[i]! - mean) / (std + 1e-8);
  return out;
}

/**
 * Percentile rank in [0,100] for each finite value; NaN passes through as NaN. Hazen /
 * mean-rank (midrank) definition over the finite cross-section: a value's percentile is
 * the fraction strictly below it plus half the fraction equal to it, scaled to 100. Ties
 * share a percentile; a lone finite name maps to 50. Mirrors research_factors._percentiles.
 */
export function percentiles(values: readonly number[]): number[] {
  const out = values.map(() => NaN);
  const finiteIdx: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i]!)) finiteIdx.push(i);
  const n = finiteIdx.length;
  if (n === 0) return out;
  const vals = finiteIdx.map((i) => values[i]!);
  for (let a = 0; a < finiteIdx.length; a++) {
    let below = 0;
    let equal = 0;
    for (let b = 0; b < vals.length; b++) {
      if (vals[b]! < vals[a]!) below++;
      else if (vals[b]! === vals[a]!) equal++;
    }
    out[finiteIdx[a]!] = (100.0 * (below + 0.5 * equal)) / n;
  }
  return out;
}

// -- Price factors (mirror of research_factors _price_factors / eligible_returns) -------

/**
 * Raw momentum + volatility for ONE ticker from a window of closes, or null when the
 * series is too short to produce >=2 return columns (the eligible_returns guard).
 *
 * momentum = cumulative log-return over a 12-1 window clamped to the available columns
 *            (252 lookback, 21 skip when there are >21 columns) — MomentumFactor's shape.
 * volatility = -(population stdev of log-returns) so higher = LOWER realised vol, keeping
 *              "higher percentile is more desirable" consistent across the four factors.
 *
 * `closes` is oldest->newest; the caller passes only the closes known as-of the date so
 * there is no look-ahead. Returns the un-z-scored raws — the cross-section z-scores them.
 */
export function priceFactorsForTicker(closes: readonly number[]): { momentum: number; volatility: number } | null {
  if (closes.length < 2) return null;
  const logRets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    const cur = closes[i]!;
    if (!(prev > 0) || !(cur > 0)) return null; // a non-positive close can't be log-differenced
    logRets.push(Math.log(cur) - Math.log(prev));
  }
  const nCols = logRets.length;
  if (nCols < 2) return null;

  const lookback = Math.min(252, nCols);
  const skip = nCols > 21 ? 21 : 0;
  const end = nCols - skip;
  const start = Math.max(0, end - lookback);
  let momentum = 0;
  for (let i = start; i < end; i++) momentum += logRets[i]!;

  // Population stdev (ddof=0) over ALL return columns — matches numpy rets.std(axis=1).
  const mean = logRets.reduce((a, b) => a + b, 0) / nCols;
  const variance = logRets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / nCols;
  const volatility = -Math.sqrt(variance);

  return { momentum, volatility };
}

// -- Dividend-yield leg (mirror of corporate-actions dividend-yield.ts) -----------------

export interface DividendForYield {
  date: string; // 'YYYY-MM-DD' ex-dividend date
  valuePerShare: number; // gross dividend per share, BASE units (already pence-killed)
}

const TRAILING_WINDOW_MS = 365 * DAY_MS;

/** 'YYYY-MM-DD' ex-date -> UTC-midnight ms (the instant the market first prices the dividend in). */
export function exDateMs(isoDate: string): number {
  return Date.parse(isoDate);
}

/**
 * Trailing-12-month dividend-per-share known as-of `asOfMs` (dividends with ex-date in
 * `(asOfMs - 365d, asOfMs]`). A future ex-date is excluded (would be look-ahead); a name
 * with no qualifying dividend returns a finite 0 (a real non-payer signal, NOT NaN).
 */
export function trailingDividendPerShare(dividends: readonly DividendForYield[], asOfMs: number): number {
  const windowStart = asOfMs - TRAILING_WINDOW_MS;
  let sum = 0;
  for (const d of dividends) {
    if (!Number.isFinite(d.valuePerShare) || d.valuePerShare < 0) continue;
    const t = exDateMs(d.date);
    if (!Number.isFinite(t)) continue;
    if (t > asOfMs) continue;
    if (t <= windowStart) continue;
    sum += d.valuePerShare;
  }
  return sum;
}

/**
 * Point-in-time trailing dividend YIELD = trailing-12m dividend-per-share / price, both
 * BASE units. `null` (NOT 0) when the price is missing/non-positive — an absent denominator
 * has no honest yield (the factor host then omits the leg, never a fabricated 0). A finite
 * price with zero trailing dividends -> a finite 0 (a real non-payer). `priceBase` is the
 * UNADJUSTED daily close (rawClose) at/<= asOf, in the same base units as the dividends.
 */
export function dividendYieldAsOf(
  dividends: readonly DividendForYield[],
  priceBase: number | null | undefined,
  asOfMs: number,
): number | null {
  if (priceBase == null || !Number.isFinite(priceBase) || priceBase <= 0) return null;
  return trailingDividendPerShare(dividends, asOfMs) / priceBase;
}

// -- factor_scores doc + per-factor source-stamping (mirror of factor_store.py) ---------

// The four research factors, fixed order — every doc carries the same keys.
export const RESEARCH_FACTORS = ['momentum', 'quality', 'value', 'volatility'] as const;
export type ResearchFactor = (typeof RESEARCH_FACTORS)[number];

// Source stamps from the T5 allowed set used by THIS backfill. Price factors are always
// 'eod' (our own EODHD-fed daily series); the div-yield leg is 'div'; everything we can't
// compute historically (Quality entirely; Value's earnings/book leg) is null — never
// fabricated. The forward-only sources ('yahoo-snapshot' / pit-*) belong to the LIVE host,
// not a historical backfill, so the backfill stamps only 'eod' / 'div' / null.
export const SOURCE_EOD = 'eod';
export const SOURCE_DIV = 'div';

export interface FactorCell {
  raw: number | null;
  pct: number | null;
  source: string | null;
}

export type FactorBlock = Record<ResearchFactor, FactorCell>;

// The honest "no source" cell — a factor we could not compute historically. Never a 0.
function nullCell(): FactorCell {
  return { raw: null, pct: null, source: null };
}

/**
 * Build ONE ticker's persisted `factors` block for a historical observation date.
 *
 *  - momentum / volatility: the cross-sectional z-score + percentile, stamped 'eod'.
 *    A null z (short history) -> the no-source cell.
 *  - value: the dividend-yield leg only — when `valueRaw` is finite the cell carries the
 *    YIELD as raw + its cross-sectional percentile, stamped 'div'. (No earnings/book leg
 *    historically — that's forward-only.) Null yield -> the no-source cell.
 *  - quality: ALWAYS the no-source cell historically (forward-only; EODHD Fundamentals not
 *    entitled, §H) — never fabricated, so a later PIT re-backfill upgrades it in place.
 *
 * `momentumPct` / `volatilityPct` / `valuePct` are this name's cross-sectional percentile
 * for that factor (or null when the name was absent from the factor's finite set).
 */
export function buildFactorBlock(input: {
  momentumZ: number | null;
  momentumPct: number | null;
  volatilityZ: number | null;
  volatilityPct: number | null;
  valueRaw: number | null;
  valuePct: number | null;
}): FactorBlock {
  const momentum: FactorCell =
    input.momentumZ == null ? nullCell() : { raw: input.momentumZ, pct: input.momentumPct, source: SOURCE_EOD };
  const volatility: FactorCell =
    input.volatilityZ == null
      ? nullCell()
      : { raw: input.volatilityZ, pct: input.volatilityPct, source: SOURCE_EOD };
  const value: FactorCell =
    input.valueRaw == null ? nullCell() : { raw: input.valueRaw, pct: input.valuePct, source: SOURCE_DIV };
  // Quality is never backfillable (forward-only) — always the honest no-source cell.
  const quality: FactorCell = nullCell();
  return { momentum, quality, value, volatility };
}

export interface FactorScoreDoc {
  ticker: string;
  observation_ts: number;
  factors: FactorBlock;
}

/**
 * Whether a factor_scores row is "fill-missing eligible" — i.e. it has at least one factor
 * cell that is the honest no-source cell (source:null) that a re-run COULD upgrade. The
 * fill-missing pass (no --force) targets exactly these rows: a fully-populated price row
 * whose Quality is still null is eligible (a future PIT warehouse fills Quality), whereas
 * the gap-aware skip alone would never revisit it. With this backfill (Quality always null)
 * every written row is technically fill-missing eligible on Quality; the predicate exists so
 * the fill-missing pass is a distinct, source:null-targeted re-run from the date-gap skip.
 */
export function hasNullSourceFactor(doc: { factors: Partial<FactorBlock> }): boolean {
  for (const factor of RESEARCH_FACTORS) {
    const cell = doc.factors[factor];
    if (!cell || cell.source == null) return true;
  }
  return false;
}

// -- held_set_snapshots mapping (mirror of HeldSetSnapshot.buildHeldSetSnapshots) -------

export interface HeldSetSnapshotDoc {
  strategy_id: string;
  observation_ts: number;
  ticker: string;
  rank: number;
  selected: boolean;
  weight: number;
  holding_age_days: number;
}

const SELECTED_WEIGHT_EPSILON = 1e-9;

/**
 * Map a historical cross-section to held_set_snapshot docs for one observation date,
 * VERBATIM to the live writer's doc shape (rank by score desc, ties by ticker; selected =
 * weight > eps; holding_age_days floored). The backfill has no replayed optimiser, so it
 * passes the historical composite scores it computed and zero weights / zero holding-age
 * (no executed-BUY history to attribute pre-deploy): every row is `selected:false`,
 * `weight:0`, but keeps its honest score `rank`. That keeps the Strategy-Impact "inclusion
 * history" surface populated with real per-cycle ranks while never inventing a holding the
 * platform didn't actually take.
 */
export function buildHeldSetSnapshots(
  input: {
    strategyId: string;
    observationTs: number;
    tickers: readonly string[];
    weights: readonly number[];
    scores: readonly number[];
    oldestOpenBuyAtByTicker: Record<string, number | undefined>;
  },
  nowMs: number,
): HeldSetSnapshotDoc[] {
  const { strategyId, observationTs, tickers, weights, scores, oldestOpenBuyAtByTicker } = input;

  const order = tickers
    .map((ticker, i) => ({ ticker, score: scores[i] ?? 0, i }))
    .sort((a, b) => b.score - a.score || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  const rankByIndex = new Array<number>(tickers.length);
  order.forEach((entry, position) => {
    rankByIndex[entry.i] = position + 1;
  });

  return tickers.map((ticker, i): HeldSetSnapshotDoc => {
    const weight = weights[i] ?? 0;
    const selected = weight > SELECTED_WEIGHT_EPSILON;
    const oldestBuyAt = oldestOpenBuyAtByTicker[ticker];
    const holdingAgeDays = oldestBuyAt != null && oldestBuyAt <= nowMs ? Math.floor((nowMs - oldestBuyAt) / DAY_MS) : 0;
    return {
      strategy_id: strategyId,
      observation_ts: observationTs,
      ticker,
      rank: rankByIndex[i] ?? i + 1,
      selected,
      weight: selected ? weight : 0,
      holding_age_days: holdingAgeDays,
    };
  });
}

// -- Cross-section assembly: one observation date -> all tickers' factor blocks ---------

export interface TickerClosesAsOf {
  ticker: string;
  closes: number[]; // oldest->newest, ONLY closes known as-of the observation date (no look-ahead)
  divYield: number | null; // point-in-time div-yield leg as-of the date, or null
}

export interface CrossSectionResult {
  factorDocs: FactorScoreDoc[];
  heldSetDocs: HeldSetSnapshotDoc[];
}

/**
 * Compute the full cross-section for ONE observation date across the universe: per-ticker
 * raw momentum/volatility from as-of closes, the div-yield leg, then cross-sectional
 * z-score + percentile for each factor, assembled into factor_scores docs (source-stamped)
 * + held_set_snapshots docs (score-ranked, weight 0 / age 0 — see buildHeldSetSnapshots).
 *
 * Pure: the migration gathers the as-of closes from Mongo/EODHD and calls this. A ticker
 * whose history is too short to produce price factors still gets a row (price cells null)
 * provided it has a div-yield leg; a ticker with neither is omitted entirely (no honest
 * factor to record).
 */
export function computeCrossSection(
  observationTs: number,
  universe: readonly TickerClosesAsOf[],
  strategyId: string,
  nowMs: number,
): CrossSectionResult {
  // Raw price factors per ticker (NaN when history too short).
  const momentumRaw: number[] = [];
  const volatilityRaw: number[] = [];
  const valueRaw: number[] = [];
  for (const u of universe) {
    const pf = priceFactorsForTicker(u.closes);
    momentumRaw.push(pf ? pf.momentum : NaN);
    volatilityRaw.push(pf ? pf.volatility : NaN);
    // Value's only backfillable leg is the div-yield; its raw IS the yield (a dimensionless
    // fraction). Cross-sectionally percentile-ranked below; it is NOT z-scored (the live
    // ValueFactor z-scores its OWN composite, and here the single leg passes through as raw
    // exactly as the live host's already-z-scored fundamentals factors do).
    valueRaw.push(u.divYield == null ? NaN : u.divYield);
  }

  // Price factors are z-scored cross-sectionally; the div-yield leg passes through as its
  // own raw (mirrors research_factors: needs_zscore = {momentum, volatility}).
  const momentumZ = crossSectionalZScores(momentumRaw);
  const volatilityZ = crossSectionalZScores(volatilityRaw);
  const momentumPct = percentiles(momentumZ);
  const volatilityPct = percentiles(volatilityZ);
  const valuePct = percentiles(valueRaw);

  const factorDocs: FactorScoreDoc[] = [];
  const heldTickers: string[] = [];
  const heldScores: number[] = [];
  for (let i = 0; i < universe.length; i++) {
    const u = universe[i]!;
    const mZ = Number.isFinite(momentumZ[i]!) ? momentumZ[i]! : null;
    const vZ = Number.isFinite(volatilityZ[i]!) ? volatilityZ[i]! : null;
    const vRaw = Number.isFinite(valueRaw[i]!) ? valueRaw[i]! : null;

    // A ticker with NO finite factor at all has nothing honest to record — omit it.
    if (mZ == null && vZ == null && vRaw == null) continue;

    factorDocs.push({
      ticker: u.ticker,
      observation_ts: observationTs,
      factors: buildFactorBlock({
        momentumZ: mZ,
        momentumPct: mZ == null ? null : (momentumPct[i] ?? null),
        volatilityZ: vZ,
        volatilityPct: vZ == null ? null : (volatilityPct[i] ?? null),
        valueRaw: vRaw,
        valuePct: vRaw == null ? null : (valuePct[i] ?? null),
      }),
    });

    // The held-set rank is driven by the dominant price factor (momentum z) — the same
    // composite the live momentum-led strategy ranks on. Names without a momentum z fall to
    // the bottom (score 0). No replayed optimiser => weight 0 / not selected for every name.
    heldTickers.push(u.ticker);
    heldScores.push(mZ ?? 0);
  }

  const heldSetDocs = buildHeldSetSnapshots(
    {
      strategyId,
      observationTs,
      tickers: heldTickers,
      weights: heldTickers.map(() => 0),
      scores: heldScores,
      oldestOpenBuyAtByTicker: {},
    },
    nowMs,
  );

  return { factorDocs, heldSetDocs };
}
