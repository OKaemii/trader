// Tests for nextAlignedTick / msUntilNextTick — locks in the wall-clock anchoring
// behaviour. The grid is anchored to UTC midnight + anchorOffsetMs. Critical that
// the function always advances strictly past `nowMs` even when nowMs sits exactly
// on a tick, otherwise the loop would never sleep.

import { describe, it, expect } from 'bun:test';
import { nextAlignedTick, msUntilNextTick } from '../poll-scheduling.ts';

const HOUR = 3_600_000;
const DAY  = 24 * HOUR;

describe('nextAlignedTick', () => {
  it('returns the next hour boundary for hourly cadence', () => {
    // 2026-05-14 09:17:30 UTC → next tick is 10:00:00 UTC
    const now      = Date.UTC(2026, 4, 14, 9, 17, 30);
    const expected = Date.UTC(2026, 4, 14, 10, 0,  0);
    expect(nextAlignedTick(HOUR, 0, now)).toBe(expected);
  });

  it('advances strictly past nowMs even when nowMs is already on a tick', () => {
    // Exactly 10:00:00 → next tick must be 11:00:00, NOT 10:00:00 (would sleep 0).
    const now      = Date.UTC(2026, 4, 14, 10, 0, 0);
    const expected = Date.UTC(2026, 4, 14, 11, 0, 0);
    expect(nextAlignedTick(HOUR, 0, now)).toBe(expected);
  });

  it('honours anchorOffsetMs for daily cadence (22:00 UTC anchor)', () => {
    // 2026-05-14 23:30 UTC, daily cadence anchored to 22:00 UTC. Previous tick was
    // today 22:00; next tick is tomorrow 22:00.
    const anchor   = 22 * HOUR;
    const now      = Date.UTC(2026, 4, 14, 23, 30, 0);
    const expected = Date.UTC(2026, 4, 15, 22, 0,  0);
    expect(nextAlignedTick(DAY, anchor, now)).toBe(expected);
  });

  it('honours anchorOffsetMs before the first anchor of the day', () => {
    // 2026-05-14 05:00 UTC, daily cadence anchored to 22:00 UTC. Next tick is
    // today 22:00 (not yesterday's, not tomorrow's).
    const anchor   = 22 * HOUR;
    const now      = Date.UTC(2026, 4, 14, 5, 0, 0);
    const expected = Date.UTC(2026, 4, 14, 22, 0, 0);
    expect(nextAlignedTick(DAY, anchor, now)).toBe(expected);
  });
});

describe('msUntilNextTick', () => {
  it('returns ms-to-next-tick (delta, not absolute)', () => {
    const now      = Date.UTC(2026, 4, 14, 9, 0, 0);
    // Next hourly tick at 10:00 → 3_600_000 ms away
    expect(msUntilNextTick(HOUR, 0, now)).toBe(HOUR);
  });

  it('is always strictly positive', () => {
    const exactlyOnTick = Date.UTC(2026, 4, 14, 10, 0, 0);
    expect(msUntilNextTick(HOUR, 0, exactlyOnTick)).toBe(HOUR);
  });
});
