// Unit tests for the pure research-backfill core — the gap math, the cross-sectional factor
// math, per-factor source-stamping, the dividend-yield leg, the held-set mapping, and the
// idempotency / fill-missing decisions. These are the "parts testable without live infra"
// (Mongo/EODHD) the card scopes; the migration entry file orchestrates the I/O around them.

import { describe, it, expect } from 'vitest';

import {
  DAY_MS,
  computeMissingRanges,
  floorToUtcDay,
  planScoreDays,
  crossSectionalZScores,
  percentiles,
  priceFactorsForTicker,
  trailingDividendPerShare,
  dividendYieldAsOf,
  buildFactorBlock,
  hasNullSourceFactor,
  buildHeldSetSnapshots,
  computeCrossSection,
  RESEARCH_FACTORS,
  SOURCE_EOD,
  SOURCE_DIV,
  type TickerClosesAsOf,
} from '../lib/research-backfill-core.ts';

const day = (n: number) => n * DAY_MS; // grid points on the UTC-day grid

describe('computeMissingRanges (gap math, mirror of shared-bars)', () => {
  it('full coverage → []', () => {
    const grid = [day(0), day(1), day(2), day(3)];
    expect(computeMissingRanges(grid, day(0), day(3), DAY_MS)).toEqual([]);
  });

  it('empty existing → the whole span', () => {
    expect(computeMissingRanges([], day(0), day(2), DAY_MS)).toEqual([{ start: day(0), end: day(2) }]);
  });

  it('interior gap → just the hole', () => {
    const held = [day(0), day(1), day(4), day(5)];
    expect(computeMissingRanges(held, day(0), day(5), DAY_MS)).toEqual([{ start: day(2), end: day(3) }]);
  });

  it('leading + trailing tails', () => {
    const held = [day(2), day(3)];
    expect(computeMissingRanges(held, day(0), day(5), DAY_MS)).toEqual([
      { start: day(0), end: day(1) },
      { start: day(4), end: day(5) },
    ]);
  });

  it('single missing point → start === end', () => {
    const held = [day(0), day(2)];
    expect(computeMissingRanges(held, day(0), day(2), DAY_MS)).toEqual([{ start: day(1), end: day(1) }]);
  });

  it('unsorted + duplicate held are tolerated', () => {
    const held = [day(3), day(1), day(1), day(0)];
    expect(computeMissingRanges(held, day(0), day(3), DAY_MS)).toEqual([{ start: day(2), end: day(2) }]);
  });

  it('throws on stepMs <= 0; returns [] when neededEnd < neededStart', () => {
    expect(() => computeMissingRanges([], 0, 10, 0)).toThrow();
    expect(computeMissingRanges([], day(5), day(0), DAY_MS)).toEqual([]);
  });

  it('a held bar drifting within a step still covers its grid point (bucket-based)', () => {
    // bar stamped a few hours past midnight still covers that day's grid point.
    const held = [day(0) + 6 * 60 * 60 * 1000, day(1) + 60_000];
    expect(computeMissingRanges(held, day(0), day(1), DAY_MS)).toEqual([]);
  });
});

describe('floorToUtcDay + planScoreDays (the backfill date planner, §I)', () => {
  it('floorToUtcDay snaps a mid-day instant to UTC midnight', () => {
    const mid = day(10) + 13 * 60 * 60 * 1000;
    expect(floorToUtcDay(mid)).toBe(day(10));
  });

  it('no existing rows → every grid day in range', () => {
    const out = planScoreDays([], day(0), day(2), false);
    expect(out).toEqual([day(0), day(1), day(2)]);
  });

  it('fully-covered span → [] (the "second run writes ~nothing" guarantee)', () => {
    const existing = [day(0), day(1), day(2)];
    expect(planScoreDays(existing, day(0), day(2), false)).toEqual([]);
  });

  it('only the missing dates are returned (gap-aware skip)', () => {
    const existing = [day(0), day(2)];
    expect(planScoreDays(existing, day(0), day(3), false)).toEqual([day(1), day(3)]);
  });

  it('--force re-computes the whole span regardless of coverage', () => {
    const existing = [day(0), day(1), day(2), day(3)];
    expect(planScoreDays(existing, day(0), day(3), true)).toEqual([day(0), day(1), day(2), day(3)]);
  });

  it('floors mid-day bounds to the grid before planning', () => {
    const start = day(0) + 9 * 60 * 60 * 1000;
    const end = day(2) + 15 * 60 * 60 * 1000;
    expect(planScoreDays([], start, end, false)).toEqual([day(0), day(1), day(2)]);
  });
});

describe('crossSectionalZScores (mirror of _price_zscores)', () => {
  it('sub-2 finite values → all NaN (no dispersion to score)', () => {
    expect(crossSectionalZScores([5]).every(Number.isNaN)).toBe(true);
    expect(crossSectionalZScores([NaN, 5, NaN]).every(Number.isNaN)).toBe(true);
  });

  it('a flat-but-finite cross-section z-scores to all 0.0 (real, rankable)', () => {
    expect(crossSectionalZScores([3, 3, 3])).toEqual([0, 0, 0]);
  });

  it('z-scores finite entries, passes NaN through', () => {
    const z = crossSectionalZScores([1, 2, 3, NaN]);
    expect(Number.isNaN(z[3]!)).toBe(true);
    // symmetric around the mean (2): outer values are negatives of each other, middle ~0.
    expect(z[0]!).toBeLessThan(0);
    expect(z[2]!).toBeGreaterThan(0);
    expect(Math.abs(z[1]!)).toBeLessThan(1e-6);
    expect(z[0]!).toBeCloseTo(-z[2]!, 9);
  });
});

describe('percentiles (Hazen midrank, mirror of _percentiles)', () => {
  it('a lone finite value maps to 50', () => {
    expect(percentiles([7])).toEqual([50]);
  });

  it('ties share the same midrank percentile', () => {
    // two equal values: each has 0 below, 2 equal → 100*(0 + 1)/2 = 50.
    expect(percentiles([4, 4])).toEqual([50, 50]);
  });

  it('monotone set spans low→high', () => {
    const p = percentiles([1, 2, 3]);
    expect(p[0]!).toBeCloseTo((100 * 0.5) / 3, 9); // lowest
    expect(p[1]!).toBeCloseTo((100 * 1.5) / 3, 9);
    expect(p[2]!).toBeCloseTo((100 * 2.5) / 3, 9); // highest
    expect(p[2]!).toBeGreaterThan(p[0]!);
  });

  it('NaN passes through; empty finite set → all NaN', () => {
    const p = percentiles([1, NaN, 3]);
    expect(Number.isNaN(p[1]!)).toBe(true);
    expect(percentiles([NaN, NaN]).every(Number.isNaN)).toBe(true);
  });
});

describe('priceFactorsForTicker (mirror of _price_factors / eligible_returns)', () => {
  it('series too short (< 2 closes, or < 2 return columns) → null', () => {
    expect(priceFactorsForTicker([])).toBeNull();
    expect(priceFactorsForTicker([100])).toBeNull();
    expect(priceFactorsForTicker([100, 101])).toBeNull(); // 1 return column < 2
  });

  it('non-positive close → null (can not log-difference)', () => {
    expect(priceFactorsForTicker([100, 0, 101])).toBeNull();
    expect(priceFactorsForTicker([100, -5, 101])).toBeNull();
  });

  it('monotonically rising series → positive momentum; flat series → 0 momentum, 0 vol', () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 * Math.pow(1.01, i));
    const pf = priceFactorsForTicker(rising)!;
    expect(pf).not.toBeNull();
    expect(pf.momentum).toBeGreaterThan(0);

    const flat = Array.from({ length: 30 }, () => 100);
    const pfFlat = priceFactorsForTicker(flat)!;
    expect(pfFlat.momentum).toBeCloseTo(0, 9);
    expect(pfFlat.volatility).toBeCloseTo(0, 9); // -stdev of all-zero returns
  });

  it('volatility is the negative of realised stdev (higher = lower vol)', () => {
    // alternating returns → non-zero stdev → negative volatility raw.
    const choppy = [100, 110, 100, 110, 100, 110, 100, 110];
    const pf = priceFactorsForTicker(choppy)!;
    expect(pf.volatility).toBeLessThan(0);
  });

  it('momentum applies the 21-day skip only when there are > 21 return columns', () => {
    // 23 closes → 22 return columns (> 21) → skip the last 21, summing the first 1 return.
    const closes = Array.from({ length: 23 }, (_, i) => 100 + i);
    const pf = priceFactorsForTicker(closes)!;
    const firstRet = Math.log(101) - Math.log(100);
    expect(pf.momentum).toBeCloseTo(firstRet, 9);
  });
});

describe('dividend-yield leg (mirror of corporate-actions dividend-yield.ts)', () => {
  const divs = [
    { date: '2025-01-15', valuePerShare: 1 },
    { date: '2025-04-15', valuePerShare: 1 },
    { date: '2025-07-15', valuePerShare: 1 },
    { date: '2025-10-15', valuePerShare: 1 },
  ];

  it('trailing-12m sums only ex-dates in (asOf - 365d, asOf]; future ex-dates excluded (no look-ahead)', () => {
    const asOf = Date.parse('2025-08-01');
    // window (2024-08-01, 2025-08-01]: Jan, Apr, Jul in; Oct is future → excluded.
    expect(trailingDividendPerShare(divs, asOf)).toBe(3);
  });

  it('a non-payer (no qualifying dividend) → finite 0, not NaN', () => {
    expect(trailingDividendPerShare([], Date.parse('2025-08-01'))).toBe(0);
  });

  it('yield = trailing / price; null when price missing/non-positive', () => {
    const asOf = Date.parse('2025-11-01'); // all 4 dividends now in the trailing year
    expect(dividendYieldAsOf(divs, 50, asOf)).toBeCloseTo(4 / 50, 9);
    expect(dividendYieldAsOf(divs, null, asOf)).toBeNull();
    expect(dividendYieldAsOf(divs, 0, asOf)).toBeNull();
    expect(dividendYieldAsOf(divs, -10, asOf)).toBeNull();
  });

  it('a finite price with zero trailing dividends → finite 0 (a real non-payer signal)', () => {
    expect(dividendYieldAsOf([], 100, Date.parse('2025-08-01'))).toBe(0);
  });
});

describe('buildFactorBlock (per-factor source-stamping, mirror of factor_store stamp rules)', () => {
  it('price factors stamp eod; value stamps div; quality is ALWAYS the no-source cell', () => {
    const block = buildFactorBlock({
      momentumZ: 1.5,
      momentumPct: 90,
      volatilityZ: -0.3,
      volatilityPct: 40,
      valueRaw: 0.05,
      valuePct: 70,
    });
    expect(block.momentum).toEqual({ raw: 1.5, pct: 90, source: SOURCE_EOD });
    expect(block.volatility).toEqual({ raw: -0.3, pct: 40, source: SOURCE_EOD });
    expect(block.value).toEqual({ raw: 0.05, pct: 70, source: SOURCE_DIV });
    // Quality is forward-only → never backfilled, never fabricated.
    expect(block.quality).toEqual({ raw: null, pct: null, source: null });
  });

  it('a null factor → the honest no-source cell {raw:null, pct:null, source:null} (never a 0)', () => {
    const block = buildFactorBlock({
      momentumZ: null,
      momentumPct: null,
      volatilityZ: null,
      volatilityPct: null,
      valueRaw: null,
      valuePct: null,
    });
    for (const f of RESEARCH_FACTORS) {
      expect(block[f]).toEqual({ raw: null, pct: null, source: null });
    }
  });

  it('every block carries all four factor keys', () => {
    const block = buildFactorBlock({
      momentumZ: 0,
      momentumPct: 50,
      volatilityZ: null,
      volatilityPct: null,
      valueRaw: null,
      valuePct: null,
    });
    expect(Object.keys(block).sort()).toEqual([...RESEARCH_FACTORS].sort());
  });
});

describe('hasNullSourceFactor (the fill-missing / idempotency predicate)', () => {
  // The CRITICAL invariant: a steady-state backfill row (Quality always null, price + value
  // sourced) is NOT fill-missing eligible — otherwise every row would always be eligible and a
  // non-force re-run would rewrite the whole span, breaking the §I "second run writes ~nothing"
  // guarantee. Only a null momentum/volatility/value (the legs THIS backfill can compute) counts.
  it('a steady-state row (price+value sourced, Quality null) is NOT eligible', () => {
    const doc = {
      factors: {
        momentum: { raw: 1, pct: 90, source: SOURCE_EOD },
        volatility: { raw: -1, pct: 10, source: SOURCE_EOD },
        value: { raw: 0.04, pct: 60, source: SOURCE_DIV },
        quality: { raw: null, pct: null, source: null }, // forward-only — NOT a trigger
      },
    };
    expect(hasNullSourceFactor(doc)).toBe(false);
  });

  it('a null momentum (then-missing history) IS eligible', () => {
    const doc = {
      factors: {
        momentum: { raw: null, pct: null, source: null }, // short history at first write
        volatility: { raw: -1, pct: 10, source: SOURCE_EOD },
        value: { raw: 0.04, pct: 60, source: SOURCE_DIV },
        quality: { raw: null, pct: null, source: null },
      },
    };
    expect(hasNullSourceFactor(doc)).toBe(true);
  });

  it('a null value leg (no div-yield yet) IS eligible', () => {
    const doc = {
      factors: {
        momentum: { raw: 1, pct: 90, source: SOURCE_EOD },
        volatility: { raw: -1, pct: 10, source: SOURCE_EOD },
        value: { raw: null, pct: null, source: null }, // div-yield landed later
        quality: { raw: null, pct: null, source: null },
      },
    };
    expect(hasNullSourceFactor(doc)).toBe(true);
  });

  it('a fully-sourced row (incl. a future PIT Quality) is NOT eligible', () => {
    const doc = {
      factors: {
        momentum: { raw: 1, pct: 90, source: SOURCE_EOD },
        volatility: { raw: -1, pct: 10, source: SOURCE_EOD },
        value: { raw: 0.04, pct: 60, source: SOURCE_DIV },
        quality: { raw: 0.7, pct: 84, source: 'yahoo-snapshot' },
      },
    };
    expect(hasNullSourceFactor(doc)).toBe(false);
  });

  it('a missing backfillable factor cell counts as eligible (defensive)', () => {
    // momentum present but volatility/value cells absent → eligible.
    expect(hasNullSourceFactor({ factors: { momentum: { raw: 1, pct: 90, source: SOURCE_EOD } } })).toBe(true);
  });
});

describe('buildHeldSetSnapshots (verbatim to the live writer mapping)', () => {
  it('ranks by score desc, ties by ticker; backfill weights/age are 0 / not selected', () => {
    const docs = buildHeldSetSnapshots(
      {
        strategyId: 'factor_rank_v1',
        observationTs: day(100),
        tickers: ['B', 'A', 'C'],
        weights: [0, 0, 0],
        scores: [2, 5, 5], // A and C tie at 5 → A ranks ahead (ticker order)
        oldestOpenBuyAtByTicker: {},
      },
      day(100),
    );
    const byTicker = Object.fromEntries(docs.map((d) => [d.ticker, d]));
    expect(byTicker.A!.rank).toBe(1);
    expect(byTicker.C!.rank).toBe(2);
    expect(byTicker.B!.rank).toBe(3);
    for (const d of docs) {
      expect(d.selected).toBe(false);
      expect(d.weight).toBe(0);
      expect(d.holding_age_days).toBe(0);
      expect(d.strategy_id).toBe('factor_rank_v1');
      expect(d.observation_ts).toBe(day(100));
    }
  });

  it('a positive weight → selected; holding_age floored from the oldest open BUY', () => {
    const now = day(100);
    const docs = buildHeldSetSnapshots(
      {
        strategyId: 's',
        observationTs: now,
        tickers: ['X'],
        weights: [0.05],
        scores: [1],
        oldestOpenBuyAtByTicker: { X: day(98) + 5 * 60 * 60 * 1000 }, // 43h before now
      },
      now,
    );
    expect(docs[0]!.selected).toBe(true);
    expect(docs[0]!.weight).toBe(0.05);
    expect(docs[0]!.holding_age_days).toBe(1); // floor(43h / 24h) = 1
  });
});

describe('computeCrossSection (full assembly for one observation date)', () => {
  // 30-day rising / falling / flat series so price factors are well-defined.
  const rising = Array.from({ length: 30 }, (_, i) => 100 * Math.pow(1.02, i));
  const falling = Array.from({ length: 30 }, (_, i) => 100 * Math.pow(0.98, i));
  const flat = Array.from({ length: 30 }, () => 100);

  const universe: TickerClosesAsOf[] = [
    { ticker: 'RISE', closes: rising, divYield: 0.06 },
    { ticker: 'FALL', closes: falling, divYield: 0.01 },
    { ticker: 'FLAT', closes: flat, divYield: null },
  ];

  it('writes one factor_scores doc per ticker with finite factors, source-stamped', () => {
    const { factorDocs } = computeCrossSection(day(200), universe, 'factor_rank_v1', day(200));
    expect(factorDocs).toHaveLength(3);
    const byTicker = Object.fromEntries(factorDocs.map((d) => [d.ticker, d]));

    // Every doc carries observation_ts + all four factor keys.
    for (const d of factorDocs) {
      expect(d.observation_ts).toBe(day(200));
      expect(Object.keys(d.factors).sort()).toEqual([...RESEARCH_FACTORS].sort());
      // Quality is never backfilled.
      expect(d.factors.quality).toEqual({ raw: null, pct: null, source: null });
    }

    // Price factors are source 'eod' and momentum ranks RISE above FALL.
    expect(byTicker.RISE!.factors.momentum.source).toBe(SOURCE_EOD);
    expect(byTicker.RISE!.factors.momentum.raw!).toBeGreaterThan(byTicker.FALL!.factors.momentum.raw!);
    expect(byTicker.RISE!.factors.momentum.pct!).toBeGreaterThan(byTicker.FALL!.factors.momentum.pct!);

    // The div-yield leg is source 'div' where present; absent → no-source cell.
    expect(byTicker.RISE!.factors.value.source).toBe(SOURCE_DIV);
    expect(byTicker.RISE!.factors.value.raw).toBeCloseTo(0.06, 9);
    expect(byTicker.FLAT!.factors.value).toEqual({ raw: null, pct: null, source: null });
  });

  it('held_set rows mirror the factor universe, ranked by momentum z, weight 0 / not selected', () => {
    const { heldSetDocs } = computeCrossSection(day(200), universe, 'factor_rank_v1', day(200));
    expect(heldSetDocs).toHaveLength(3);
    const byTicker = Object.fromEntries(heldSetDocs.map((d) => [d.ticker, d]));
    expect(byTicker.RISE!.rank).toBe(1); // highest momentum
    expect(byTicker.FALL!.rank).toBe(3); // lowest momentum
    for (const d of heldSetDocs) {
      expect(d.selected).toBe(false);
      expect(d.weight).toBe(0);
      expect(d.strategy_id).toBe('factor_rank_v1');
    }
  });

  it('a ticker with NO finite factor (short history, no div-yield) is omitted entirely', () => {
    const sparse: TickerClosesAsOf[] = [
      { ticker: 'GOOD', closes: rising, divYield: 0.03 },
      { ticker: 'EMPTY', closes: [100], divYield: null }, // too short, no div-yield
    ];
    const { factorDocs, heldSetDocs } = computeCrossSection(day(10), sparse, 's', day(10));
    expect(factorDocs.map((d) => d.ticker)).toEqual(['GOOD']);
    expect(heldSetDocs.map((d) => d.ticker)).toEqual(['GOOD']);
  });

  it('a short-history name that still has a div-yield gets a row with null price factors but a div value', () => {
    const mixed: TickerClosesAsOf[] = [
      { ticker: 'LONG', closes: rising, divYield: 0.05 },
      { ticker: 'SHORTDIV', closes: [100], divYield: 0.02 }, // no price factors, but a div-yield
    ];
    const { factorDocs } = computeCrossSection(day(10), mixed, 's', day(10));
    const short = factorDocs.find((d) => d.ticker === 'SHORTDIV')!;
    expect(short).toBeDefined();
    expect(short.factors.momentum).toEqual({ raw: null, pct: null, source: null });
    expect(short.factors.volatility).toEqual({ raw: null, pct: null, source: null });
    expect(short.factors.value.source).toBe(SOURCE_DIV);
    expect(short.factors.value.raw).toBeCloseTo(0.02, 9);
  });
});
