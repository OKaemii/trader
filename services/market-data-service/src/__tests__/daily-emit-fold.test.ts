// Unit tests for foldDailyEmit (RC1 Task 3) — the shared read→group→aggregate→persist→publish
// fold behind BOTH the gated session-close path (maybeEmitDailyAtClose) and the operator force
// route. The gate lives at the callers; this fold is gate-free, so the tests pin its contract
// directly: it reads today's 5m bars through the dispatched SET reader (never a raw Mongo find),
// rolls each ticker's bars up to one daily bar, publishes the set to market:raw:daily, and returns
// the count. An empty day returns { emitted: 0 } WITHOUT throwing and WITHOUT publishing — the
// "never throw on no bars" invariant the route's emitted:0 response depends on. A past date's
// optional upper bound trims the fold to that single UTC day (the reader is lower-bounded only).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OHLCVBar } from '@trader/shared-types';
import { Trading212TickerAdapter } from '@trader/ticker-identity';

const adapter = new Trading212TickerAdapter();

// Hoisted seam: the reader, the bi-temporal writer, the cache-invalidate, and the stream publish.
// aggregateBars is left REAL so the fold is genuinely exercised (one daily bar per ticker).
const h = vi.hoisted(() => ({
  recentBars: vi.fn(),
  writeBars: vi.fn(async () => ({ attempted: 0, inserted: 0, revisions: 0, skipped: 0 })),
  invalidate: vi.fn(async () => {}),
  xAdd: vi.fn(async () => ''),
}));

vi.mock('@trader/shared-redis', async (orig) => ({
  ...(await orig() as any),
  xAdd: (...a: any[]) => h.xAdd(...a),
}));
vi.mock('@trader/shared-bars', async (orig) => ({
  ...(await orig() as any),
  invalidateBarsBulk: (...a: any[]) => h.invalidate(...a),
  getRecentBarsForTickers: (...a: any[]) => h.recentBars(...a),
}));
vi.mock('../modules/bars/infrastructure/persist-bars.ts', async (orig) => ({
  ...(await orig() as any),
  writeBarRevisions: (...a: any[]) => h.writeBars(...a),
}));

import { foldDailyEmit } from '../modules/bars/infrastructure/daily-emit.ts';

const UTC_DATE = '2026-06-12';                                   // a past Friday (the QA day)
const SINCE = Date.parse(`${UTC_DATE}T00:00:00.000Z`);
const NEXT_MIDNIGHT = SINCE + 24 * 60 * 60_000;

function bar(symbol: string, market: 'US' | 'LSE', tsOffsetMs: number, close: number): OHLCVBar {
  const observation_ts = SINCE + tsOffsetMs;
  return {
    ticker: adapter.toT212({ symbol, market }),
    observation_ts,
    timestamp: observation_ts,
    interval: '5m',
    open: close, high: close, low: close, close, volume: 100,
  };
}

const redis = {} as never;
const db = {} as never;

beforeEach(() => {
  h.recentBars.mockReset();
  h.writeBars.mockClear();
  h.invalidate.mockClear();
  h.xAdd.mockClear();
});

describe('foldDailyEmit — the read→aggregate→publish fold', () => {
  it('reads through the dispatched set reader with the day-bounded 5m query', async () => {
    h.recentBars.mockResolvedValue([bar('AAPL', 'US', 14 * 3_600_000, 100)]);

    await foldDailyEmit(redis, db, ['AAPL_US_EQ'], SINCE);

    expect(h.recentBars).toHaveBeenCalledTimes(1);
    const [, , idsArg, queryArg] = h.recentBars.mock.calls[0]!;
    // T212 ticker split to the bare identity SET (storage is keyed bare).
    expect(idsArg).toEqual([{ symbol: 'AAPL', market: 'US' }]);
    // Lower-bounded at the UTC-day floor — the load-bearing OOM-safe read.
    expect(queryArg).toEqual({ interval: '5m', sinceTs: SINCE });
  });

  it('rolls each ticker up to ONE daily bar and publishes the set to market:raw:daily', async () => {
    // Two tickers, multiple 5m bars each — the real aggregateBars must collapse to one daily bar/ticker.
    h.recentBars.mockResolvedValue([
      bar('AAPL', 'US', 14 * 3_600_000, 100),
      bar('AAPL', 'US', 14 * 3_600_000 + 5 * 60_000, 101),
      bar('AAPL', 'US', 15 * 3_600_000, 102),
      bar('MSFT', 'US', 14 * 3_600_000, 200),
      bar('MSFT', 'US', 15 * 3_600_000, 205),
    ]);

    const res = await foldDailyEmit(redis, db, ['AAPL_US_EQ', 'MSFT_US_EQ'], SINCE);

    expect(res.emitted).toBe(2);
    // Persisted bi-temporally + cache-invalidated + published, in that order.
    expect(h.writeBars).toHaveBeenCalledTimes(1);
    const [, writtenBars, writtenInterval] = h.writeBars.mock.calls[0]!;
    expect(writtenInterval).toBe('daily');
    expect(writtenBars).toHaveLength(2);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    expect(h.xAdd).toHaveBeenCalledTimes(1);
    const [, stream, payload] = h.xAdd.mock.calls[0]!;
    expect(stream).toBe('market:raw:daily');
    expect(payload).toHaveLength(2);
    const tickers = (payload as OHLCVBar[]).map((b) => b.ticker).sort();
    expect(tickers).toEqual(['AAPL_US_EQ', 'MSFT_US_EQ']);
    for (const b of payload as OHLCVBar[]) expect(b.interval).toBe('daily');
    // The AAPL daily bar reflects the day's range: close = last 5m close (102), high >= 102.
    const aapl = (payload as OHLCVBar[]).find((b) => b.ticker === 'AAPL_US_EQ')!;
    expect(aapl.close).toBe(102);
    expect(aapl.high).toBeGreaterThanOrEqual(102);
  });

  it('caps the fold to the requested UTC day when an upper bound is given (past-date case)', async () => {
    // The reader (lower-bounded only) returns this day's bars AND a bar from the next day; the
    // upperBoundTs must drop the out-of-day bar so a past date folds only its own session.
    h.recentBars.mockResolvedValue([
      bar('AAPL', 'US', 14 * 3_600_000, 100),                    // in-day
      bar('AAPL', 'US', 15 * 3_600_000, 101),                    // in-day
      bar('AAPL', 'US', 24 * 3_600_000 + 14 * 3_600_000, 999),   // NEXT day — must be excluded
    ]);

    const res = await foldDailyEmit(redis, db, ['AAPL_US_EQ'], SINCE, NEXT_MIDNIGHT);

    expect(res.emitted).toBe(1);
    const [, payload] = h.xAdd.mock.calls[0]!.slice(1);
    const aapl = (payload as OHLCVBar[])[0]!;
    // The next-day 999 bar was trimmed → the daily close is the in-day last (101), not 999.
    expect(aapl.close).toBe(101);
    expect(aapl.high).toBeLessThan(999);
  });

  it('emits both markets\' tickers when handed a mixed set', async () => {
    h.recentBars.mockResolvedValue([
      bar('AAPL', 'US', 14 * 3_600_000, 100),
      bar('VOD', 'LSE', 12 * 3_600_000, 50),
    ]);

    const res = await foldDailyEmit(redis, db, ['AAPL_US_EQ', 'VODl_EQ'], SINCE);

    expect(res.emitted).toBe(2);
    const [, , idsArg] = h.recentBars.mock.calls[0]!;
    expect(idsArg).toEqual([{ symbol: 'AAPL', market: 'US' }, { symbol: 'VOD', market: 'LSE' }]);
  });
});

describe('foldDailyEmit — empty-day invariant (emitted:0, never throws, never publishes)', () => {
  it('returns { emitted: 0 } with no publish when the reader finds no 5m bars', async () => {
    h.recentBars.mockResolvedValue([]);

    const res = await foldDailyEmit(redis, db, ['AAPL_US_EQ'], SINCE);

    expect(res).toEqual({ emitted: 0 });
    expect(h.writeBars).not.toHaveBeenCalled();
    expect(h.xAdd).not.toHaveBeenCalled();             // nothing published — the strategy isn't poked
  });

  it('returns { emitted: 0 } when an upper bound trims every bar out of the day', async () => {
    // Reader returns only a NEXT-day bar; the upper-bound trim empties the set → emitted 0, no throw.
    h.recentBars.mockResolvedValue([bar('AAPL', 'US', 24 * 3_600_000 + 14 * 3_600_000, 999)]);

    const res = await foldDailyEmit(redis, db, ['AAPL_US_EQ'], SINCE, NEXT_MIDNIGHT);

    expect(res).toEqual({ emitted: 0 });
    expect(h.xAdd).not.toHaveBeenCalled();
  });

  it('returns { emitted: 0 } for an empty ticker set without touching the reader', async () => {
    const res = await foldDailyEmit(redis, db, [], SINCE);

    expect(res).toEqual({ emitted: 0 });
    expect(h.recentBars).not.toHaveBeenCalled();
    expect(h.xAdd).not.toHaveBeenCalled();
  });
});
