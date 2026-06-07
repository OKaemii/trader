// Tests for the gap-aware coverage helpers — the shared foundation every gap-aware
// backfill (Task 16 daily-history retrofit, Task 17 research-backfill) builds on.
// Locks in the grid-bucket contract: a needed span is a discrete stepMs grid, a grid
// point is covered when a held observation lands in its [point, point+step) bucket, and
// contiguous holes collapse into one MissingRange. The four card-mandated cases —
// interior gap, tail gap, full coverage → [], empty store → whole span — plus the
// leading tail, dedup/unsorted tolerance, and the coverageOf query shape.

import { describe, it, expect } from "vitest";
import { computeMissingRanges, coverageOf } from '../index.ts';
import type { MissingRange } from '../index.ts';

const DAY = 24 * 60 * 60 * 1000;

// A clean daily grid anchored at 0 so expected timestamps read as day-indices × DAY.
function days(...idx: number[]): number[] {
  return idx.map((i) => i * DAY);
}
function span(startDay: number, endDay: number): MissingRange {
  return { start: startDay * DAY, end: endDay * DAY };
}

describe('computeMissingRanges', () => {
  it('empty store → the whole needed span', () => {
    // Needed days 0..4, nothing held → one gap spanning every grid point.
    expect(computeMissingRanges([], 0, 4 * DAY, DAY)).toEqual([span(0, 4)]);
  });

  it('full coverage → []', () => {
    const held = days(0, 1, 2, 3, 4);
    expect(computeMissingRanges(held, 0, 4 * DAY, DAY)).toEqual([]);
  });

  it('interior gap → only the hole between covered ends', () => {
    // Hold days 0,1 and 4 — days 2,3 are an interior hole.
    const held = days(0, 1, 4);
    expect(computeMissingRanges(held, 0, 4 * DAY, DAY)).toEqual([span(2, 3)]);
  });

  it('trailing tail → needed extends past the latest held day', () => {
    // Hold days 0,1,2; needed runs to day 5 → tail 3..5.
    const held = days(0, 1, 2);
    expect(computeMissingRanges(held, 0, 5 * DAY, DAY)).toEqual([span(3, 5)]);
  });

  it('leading tail → needed begins before the earliest held day', () => {
    // Hold days 3,4,5; needed starts at day 0 → leading gap 0..2.
    const held = days(3, 4, 5);
    expect(computeMissingRanges(held, 0, 5 * DAY, DAY)).toEqual([span(0, 2)]);
  });

  it('multiple disjoint gaps (leading + interior + trailing)', () => {
    // Held: day 2 and day 5; needed days 0..7.
    const held = days(2, 5);
    expect(computeMissingRanges(held, 0, 7 * DAY, DAY)).toEqual([
      span(0, 1),   // leading
      span(3, 4),   // interior
      span(6, 7),   // trailing
    ]);
  });

  it('single missing observation → start === end', () => {
    // Hold every day but day 3.
    const held = days(0, 1, 2, 4, 5);
    expect(computeMissingRanges(held, 0, 5 * DAY, DAY)).toEqual([span(3, 3)]);
  });

  it('tolerates unsorted input and duplicate observations', () => {
    const held = days(4, 0, 1, 4, 0); // day 2,3 missing, dupes + out of order
    expect(computeMissingRanges(held, 0, 4 * DAY, DAY)).toEqual([span(2, 3)]);
  });

  it('a held observation anywhere in a bucket covers that grid point', () => {
    // Daily bar stamped mid-day (session-close drift) still covers its 00:00 grid point.
    const held = [0, DAY + 12 * 60 * 60 * 1000, 2 * DAY]; // day1 stamped at noon
    expect(computeMissingRanges(held, 0, 2 * DAY, DAY)).toEqual([]);
  });

  it('held observations outside the needed span do not mask gaps', () => {
    // Holdings entirely before/after the window must not be counted as coverage.
    const held = days(-2, -1, 6, 7);
    expect(computeMissingRanges(held, 0, 5 * DAY, DAY)).toEqual([span(0, 5)]);
  });

  it('neededEnd < neededStart → []', () => {
    expect(computeMissingRanges([], 10 * DAY, 0, DAY)).toEqual([]);
  });

  it('throws on non-positive stepMs', () => {
    expect(() => computeMissingRanges([], 0, DAY, 0)).toThrow(/stepMs must be > 0/);
    expect(() => computeMissingRanges([], 0, DAY, -1)).toThrow(/stepMs must be > 0/);
  });
});

// In-memory Mongo collection stub mirroring the chained find().sort().toArray() shape the
// driver exposes — records the filter + projection so we assert coverageOf queries the
// live (is_superseded:false) fast lane over the right observation_ts window.
function makeDbWith(docs: Array<Record<string, unknown>>) {
  const findCalls: Array<{ filter: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  return {
    findCalls,
    collection: (_name: string) => ({
      find: (filter: Record<string, unknown>, options?: Record<string, unknown>) => {
        findCalls.push({ filter, options });
        const obsFilter = (filter.observation_ts as { $gte?: number } | undefined);
        const matched = docs.filter((d) => {
          if (filter.ticker !== undefined && d.ticker !== filter.ticker) return false;
          if (filter.interval !== undefined && d.interval !== filter.interval) return false;
          if (filter.is_superseded !== undefined && d.is_superseded !== filter.is_superseded) return false;
          if (obsFilter?.$gte !== undefined && (d.observation_ts as number) < obsFilter.$gte) return false;
          return true;
        });
        return {
          sort: (_s: Record<string, number>) => ({
            toArray: async () => matched.slice().sort(
              (a, b) => (a.observation_ts as number) - (b.observation_ts as number),
            ),
          }),
        };
      },
    }),
  };
}

describe('coverageOf', () => {
  const NOW = 100 * DAY;

  it('returns held observations ascending + the [now-range, now] needed bounds, plugging into computeMissingRanges', async () => {
    const db = makeDbWith([
      { ticker: 'AAPL_US_EQ', interval: 'daily', is_superseded: false, observation_ts: 98 * DAY },
      { ticker: 'AAPL_US_EQ', interval: 'daily', is_superseded: false, observation_ts: 99 * DAY },
    ]);
    const { observed, neededStart, neededEnd } = await coverageOf(
      db as never, 'AAPL_US_EQ', 'daily', '5y', NOW,
    );
    expect(observed).toEqual([98 * DAY, 99 * DAY]);
    expect(neededEnd).toBe(NOW);
    expect(neededStart).toBe(NOW - 1825 * DAY); // RANGE_DAYS['5y'] = 1825
    // The shape feeds straight into the gap math.
    const gaps = computeMissingRanges(observed, neededStart, neededEnd, DAY);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[gaps.length - 1]!.end).toBe(NOW);
  });

  it('queries the live fast lane: is_superseded:false, matching ticker/interval, observation_ts ≥ neededStart', async () => {
    const db = makeDbWith([]);
    await coverageOf(db as never, 'VOD_l_EQ', 'daily', '1y', NOW);
    expect(db.findCalls).toHaveLength(1);
    const { filter, options } = db.findCalls[0]!;
    expect(filter).toMatchObject({
      ticker: 'VOD_l_EQ',
      interval: 'daily',
      is_superseded: false,
      observation_ts: { $gte: NOW - 365 * DAY },
    });
    // Projects observation_ts only — we never need the full bar doc for coverage.
    expect(options?.projection).toMatchObject({ observation_ts: 1 });
  });

  it('empty store → empty observed → computeMissingRanges yields the whole span', async () => {
    const db = makeDbWith([]);
    const { observed, neededStart, neededEnd } = await coverageOf(
      db as never, 'MSFT_US_EQ', 'daily', '30d', NOW,
    );
    expect(observed).toEqual([]);
    const gaps = computeMissingRanges(observed, neededStart, neededEnd, DAY);
    expect(gaps).toEqual([{ start: neededStart, end: neededStart + 30 * DAY }]);
  });

  it('drops non-numeric observation_ts defensively', async () => {
    const db = makeDbWith([
      { ticker: 'X_US_EQ', interval: 'daily', is_superseded: false, observation_ts: 99 * DAY },
      { ticker: 'X_US_EQ', interval: 'daily', is_superseded: false, observation_ts: 'bad' },
    ]);
    const { observed } = await coverageOf(db as never, 'X_US_EQ', 'daily', '5y', NOW);
    expect(observed).toEqual([99 * DAY]);
  });
});
