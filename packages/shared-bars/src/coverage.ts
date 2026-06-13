// shared-bars — gap-aware coverage helpers.
//
// The shared foundation for every gap-aware backfill/sync in the platform. Backfills
// must never spend upstream credits (EODHD/TwelveData) on observation dates we already
// hold: before fetching, a caller asks "which sub-ranges of the needed span am I
// missing?" and paginates only those gaps. A fully-covered ticker makes zero upstream
// calls. See agent-docs/plans/research-trading-os.md §I (Incremental, gap-aware,
// credit-thrifty sync).
//
// Two pieces:
//   • computeMissingRanges() — pure grid math: given the observation_ts we already hold
//     and a needed [start, end] span on a fixed step grid, return the uncovered
//     sub-ranges (interior gaps AND leading/trailing tail).
//   • coverageOf() — the Mongo query that materialises "what we hold" for a (ticker,
//     interval) over a RangeKey, shaped to feed straight into computeMissingRanges.

import type { Db } from 'mongodb';
import type { BarInterval } from '@trader/shared-types';
import { COLLECTIONS } from '@trader/shared-mongo';
import type { RangeKey } from './index.ts';
import { RANGE_DAYS } from './index.ts';
import { identityOf } from './identity.ts';

/**
 * A grid-inclusive uncovered span. Both bounds are aligned `observation_ts` values (ms)
 * that fall on the `stepMs` grid: `start` is the first missing observation, `end` the
 * last. A single missing observation yields `{ start, end }` with `start === end`.
 * Callers translate these grid bounds into a provider date-range fetch.
 */
export interface MissingRange {
  start: number;
  end: number;
}

/**
 * Compute the uncovered sub-ranges of `[neededStart, neededEnd]` given the observation
 * timestamps we already hold (`existing`). The needed span is treated as a discrete grid
 * of points `neededStart, neededStart + stepMs, …, ≤ neededEnd`; a grid point is "covered"
 * when some held observation lands in its `[point, point + stepMs)` bucket. Contiguous
 * uncovered points collapse into one `MissingRange`.
 *
 * This is deliberately bucket-based rather than exact-equality so it tolerates the small
 * intraday/timezone drift between a held bar's stamp and the grid anchor (e.g. a daily bar
 * stamped at a session-close instant vs the 00:00:00Z grid): any held observation within a
 * step of a grid point marks that point covered, so we never re-fetch a date we hold.
 *
 * Returns:
 *   • interior gaps — covered, hole, covered → the hole
 *   • leading tail  — needed starts before the earliest held observation
 *   • trailing tail — needed extends past the latest held observation
 *   • `[]` when every grid point is covered (full coverage → zero fetch)
 *   • the whole `[neededStart, alignedLastPoint]` span when `existing` is empty
 *
 * Pure + allocation-light: one sort of `existing`, one linear grid walk. No I/O.
 *
 * @param existing     observation_ts (ms) already held; unsorted-tolerant, dupes-tolerant.
 * @param neededStart  first observation_ts (ms) the caller needs (grid anchor).
 * @param neededEnd    last observation_ts (ms) the caller needs (inclusive upper bound).
 * @param stepMs       grid spacing in ms (e.g. 86_400_000 for a daily series). Must be > 0.
 */
export function computeMissingRanges(
  existing: readonly number[],
  neededStart: number,
  neededEnd: number,
  stepMs: number,
): MissingRange[] {
  if (stepMs <= 0) throw new Error('[coverage] computeMissingRanges: stepMs must be > 0');
  if (neededEnd < neededStart) return [];

  // Sorted copy so we can advance a single pointer over the grid in O(n+m). A held
  // observation covers the grid point whose bucket [point, point+stepMs) contains it.
  const held = Array.from(existing).sort((a, b) => a - b);

  const out: MissingRange[] = [];
  let runStart: number | null = null;   // first uncovered point of the current gap run
  let prevPoint = neededStart;          // last grid point visited (for run closure)
  let heldIdx = 0;

  for (let point = neededStart; point <= neededEnd; point += stepMs) {
    const bucketEnd = point + stepMs;   // exclusive

    // Drop held observations that fall before this bucket — the grid only advances, so
    // they can't cover this or any later point.
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

  // Close a gap that runs to the end of the needed span (trailing tail / whole span).
  if (runStart !== null) out.push({ start: runStart, end: prevPoint });

  return out;
}

/**
 * Coverage of (`ticker`, `interval`) over `range`: the held `observation_ts` (ms) and the
 * grid bounds a caller feeds into computeMissingRanges. Live, unsuperseded rows only — the
 * fast lane the partial-unique index serves. `neededStart` is `now − RANGE_DAYS[range]`
 * (matching getBars' read window) and `neededEnd` is `now`, so the returned shape plugs
 * directly into computeMissingRanges:
 *
 *   const { observed, neededStart, neededEnd } = await coverageOf(db, t, 'daily', '5y');
 *   const gaps = computeMissingRanges(observed, neededStart, neededEnd, 86_400_000);
 *
 * Returns observations ascending. An empty `observed` means "nothing held in range" →
 * computeMissingRanges yields the whole span.
 *
 * **Grid-alignment caveat for daily callers.** `neededStart`/`neededEnd` are anchored to
 * the raw `now` instant (mid-day in practice), while daily bars are stamped at 00:00:00Z.
 * Feeding these bounds straight into `computeMissingRanges(_, _, _, 86_400_000)` therefore
 * puts the grid points a fractional day off the bar stamps, so the trailing grid point can
 * read as a ≤1-step gap on a calendar-complete ticker (one redundant, hash-gated no-op
 * fetch — never a data error). A gap-aware backfill that wants a true zero-fetch tail should
 * floor `neededEnd` (and its step grid) to the bar-stamp convention — e.g. UTC midnight for
 * the daily series — before calling `computeMissingRanges`.
 *
 * Reads Mongo (`COLLECTIONS.OHLCV_BARS`) directly — this matches where the current backfills
 * write and the default `BARS_BACKEND=mongo`. It does **not** consult `BARS_BACKEND`; if
 * Timescale ever becomes the live bars store, coverage detection must move with it.
 *
 * @param now  injectable clock for deterministic tests; defaults to Date.now().
 */
export async function coverageOf(
  db: Db,
  ticker: string,
  interval: BarInterval,
  range: RangeKey,
  now: number = Date.now(),
): Promise<{ observed: number[]; neededStart: number; neededEnd: number }> {
  const neededStart = now - RANGE_DAYS[range] * 24 * 60 * 60 * 1000;
  const neededEnd = now;
  const { symbol, market } = identityOf(ticker);

  const docs = await db
    .collection(COLLECTIONS.OHLCV_BARS)
    .find(
      { symbol, market, interval, is_superseded: false, observation_ts: { $gte: neededStart } },
      { projection: { _id: 0, observation_ts: 1 } },
    )
    .sort({ observation_ts: 1 })
    .toArray();

  const observed: number[] = [];
  for (const d of docs) {
    const ts = (d as { observation_ts?: unknown }).observation_ts;
    if (typeof ts === 'number') observed.push(ts);
  }

  return { observed, neededStart, neededEnd };
}
