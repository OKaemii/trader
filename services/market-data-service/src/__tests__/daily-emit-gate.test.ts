// Regression test for the daily-emit gate leak (epic post-pit-coverage-bugs, Task 2 — pins PR #152).
//
// THE BUG: `maybeEmitDailyAtClose` acquires a once-per-day NX gate
// (`market-data:daily-emit:<MKT>:<UTCdate>`, 25h TTL) BEFORE the "are there any 5m bars yet?" check.
// An early CLOSED-state cycle / pod restart that runs before the EOD poll has fetched today's bars
// found none, skipped — and LEFT THE GATE SET for 25h. The real emit (once bars landed) was then gated
// out → `market:raw:daily` never published → strategy-engine never cycled → "factor percentiles unknown".
//
// THE FIX: release the gate (`redis.del`) on the no-bars and zero-aggregation skips so a later
// same-day cycle re-acquires and emits. These tests pin exactly that: empty → gate released (and a
// later cycle is NOT blocked); bars present → emit + gate retained.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OHLCVBar } from '@trader/shared-types';
import { Trading212TickerAdapter } from '@trader/ticker-identity';

const adapter = new Trading212TickerAdapter();

// Hoisted mutable state the mocks read (vi.mock factories are hoisted above imports).
const h = vi.hoisted(() => ({ docs: [] as any[], xAdd: vi.fn(async () => {}), recentBars: vi.fn() }));

vi.mock('@trader/shared-mongo', async (orig) => ({
  ...(await orig() as any),
  getMongoDb: async () => ({}),       // db handle is opaque here — the 5m read goes through the seam below
}));
vi.mock('@trader/shared-redis', async (orig) => ({
  ...(await orig() as any),
  xAdd: (...a: any[]) => h.xAdd(...a),
}));
vi.mock('../modules/bars/infrastructure/persist-bars.ts', async (orig) => ({
  ...(await orig() as any),
  writeBarRevisions: async () => ({ attempted: 0, inserted: 0, revisions: 0, skipped: 0 }),
}));
// maybeEmitDailyAtClose now reads 5m bars through the BARS_BACKEND-dispatched set-reader, not a raw
// Mongo find — so the test controls the bars via getRecentBarsForTickers. The mock returns OHLCVBar[]
// built from h.docs exactly as the real reader does (T212 ticker re-derived), keying the gate-release
// regression on what the dispatcher returns regardless of backend.
vi.mock('@trader/shared-bars', async (orig) => ({
  ...(await orig() as any),
  invalidateBarsBulk: async () => {},
  getRecentBarsForTickers: (...a: any[]) => h.recentBars(...a),
}));
// Force the market state emit-eligible without touching the real holiday-cache mongo path.
vi.mock('@trader/shared-calendar', async (orig) => ({
  ...(await orig() as any),
  marketStateOf: async () => 'CLOSED',
}));

import { maybeEmitDailyAtClose } from '../index.ts';

// Pass every market state so the real `marketStateOf` result is always emit-eligible — the test
// controls the gate/bars path without mocking the calendar.
const ALL_STATES = ['REGULAR', 'PRE', 'POST', 'CLOSED'] as const;
const UTC_DATE = new Date().toISOString().slice(0, 10);
const US_GATE = `market-data:daily-emit:US:${UTC_DATE}`;
const UTC_MIDNIGHT = Date.parse(`${UTC_DATE}T00:00:00.000Z`);

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (k: string, v: string, opts?: any) => {
      if (opts?.NX && store.has(k)) return null;     // NX: fail if already held
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
  };
}

// The set-reader returns fully-formed OHLCVBar[] with the T212 ticker re-derived from (symbol, market).
// Build fixtures with the bare identity; the reader mock maps them to bars exactly as production does.
function doc(symbol: string, market: 'US' | 'LSE', ts: number, close: number) {
  return { symbol, market, observation_ts: ts, interval: '5m', open: close, high: close, low: close, close, volume: 100 };
}
function docToBar(d: ReturnType<typeof doc>): OHLCVBar {
  return {
    ticker:         adapter.toT212({ symbol: d.symbol, market: d.market }),
    observation_ts: d.observation_ts,
    timestamp:      d.observation_ts,
    interval:       '5m',
    open:           d.open, high: d.high, low: d.low, close: d.close, volume: d.volume,
  };
}

beforeEach(() => {
  h.docs = [];
  h.xAdd.mockClear();
  // Default: the dispatched reader returns bars derived from h.docs (whichever the test set up).
  h.recentBars.mockReset();
  h.recentBars.mockImplementation(async () => h.docs.map(docToBar));
});

describe('maybeEmitDailyAtClose — gate release on empty (PR #152 regression)', () => {
  it('releases the gate when no 5m bars are found yet (so it is not burned for 25h)', async () => {
    h.docs = [];                                       // EOD poll hasn't landed today's bars yet
    const redis = fakeRedis();

    await maybeEmitDailyAtClose(redis as any, { US: ['AAPL_US_EQ'], LSE: [] }, 1, ALL_STATES);

    expect(redis.set).toHaveBeenCalled();              // gate was acquired
    expect(redis.del).toHaveBeenCalledWith(US_GATE);   // ...then RELEASED on the no-bars skip
    expect(redis.store.has(US_GATE)).toBe(false);      // not left burned
    expect(h.xAdd).not.toHaveBeenCalled();             // nothing emitted
  });

  it('does NOT stay burned — a later same-day cycle re-acquires the gate', async () => {
    h.docs = [];
    const redis = fakeRedis();

    await maybeEmitDailyAtClose(redis as any, { US: ['AAPL_US_EQ'], LSE: [] }, 1, ALL_STATES);
    await maybeEmitDailyAtClose(redis as any, { US: ['AAPL_US_EQ'], LSE: [] }, 2, ALL_STATES);

    // Both cycles acquired (NX succeeded twice because the first released) and both released.
    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(redis.del).toHaveBeenCalledTimes(2);
    expect(redis.store.has(US_GATE)).toBe(false);
  });

  it('emits and RETAINS the gate once bars are present', async () => {
    h.docs = [
      doc('AAPL', 'US', UTC_MIDNIGHT + 14 * 3_600_000, 100),
      doc('AAPL', 'US', UTC_MIDNIGHT + 14 * 3_600_000 + 60_000, 101),
    ];
    const redis = fakeRedis();

    await maybeEmitDailyAtClose(redis as any, { US: ['AAPL_US_EQ'], LSE: [] }, 3, ALL_STATES);

    expect(h.xAdd).toHaveBeenCalledTimes(1);           // market:raw:daily published
    expect(redis.del).not.toHaveBeenCalled();          // gate NOT released — the day's emit is done
    expect(redis.store.has(US_GATE)).toBe(true);       // held for the rest of the UTC day
  });

  it('a burned gate from a prior emit blocks a duplicate emit (NX is load-bearing)', async () => {
    h.docs = [doc('AAPL', 'US', UTC_MIDNIGHT + 14 * 3_600_000, 100)];
    const redis = fakeRedis();
    redis.store.set(US_GATE, '1');                     // already emitted earlier this UTC day

    await maybeEmitDailyAtClose(redis as any, { US: ['AAPL_US_EQ'], LSE: [] }, 4, ALL_STATES);

    expect(h.xAdd).not.toHaveBeenCalled();             // NX blocked the second emit
  });
});

// RC1 core (this card): the emit MUST read 5m bars through the BARS_BACKEND dispatcher, never a raw
// Mongo find. Under the live config (BARS_BACKEND=timescale, DUAL_WRITE_BARS=false) the wipe left
// Mongo ohlcv_bars empty, so a direct Mongo read returns 0 rows forever and market:raw:daily never
// publishes — the strategy-starve bug. These tests pin that the dispatched reader is the read path
// and that Timescale-sourced bars still publish even when the Mongo collection is empty/inert.
describe('maybeEmitDailyAtClose — reads via the dispatched set-reader, publishes market:raw:daily (RC1)', () => {
  it('with BARS_BACKEND=timescale: reads through getRecentBarsForTickers (not Mongo) and publishes', async () => {
    const prev = process.env.BARS_BACKEND;
    process.env.BARS_BACKEND = 'timescale';
    try {
      // Timescale holds Friday's 5m bars; Mongo ohlcv_bars is empty (the wipe). The reader returns the
      // Timescale rows regardless — wire them as if read from Timescale.
      const tsBars: OHLCVBar[] = [
        doc('AAPL', 'US', UTC_MIDNIGHT + 14 * 3_600_000, 100),
        doc('AAPL', 'US', UTC_MIDNIGHT + 14 * 3_600_000 + 60_000, 101),
      ].map(docToBar);
      h.recentBars.mockImplementation(async () => tsBars);
      const redis = fakeRedis();

      await maybeEmitDailyAtClose(redis as any, { US: ['AAPL_US_EQ'], LSE: [] }, 5, ALL_STATES);

      // The dispatched reader was the 5m read path, queried with the day-bounded 5m set query.
      expect(h.recentBars).toHaveBeenCalledTimes(1);
      const [, , idsArg, queryArg] = h.recentBars.mock.calls[0]!;
      expect(idsArg).toEqual([{ symbol: 'AAPL', market: 'US' }]);   // T212 split to the bare identity set
      expect(queryArg).toEqual({ interval: '5m', sinceTs: UTC_MIDNIGHT });

      // …and the Timescale-sourced bars published to market:raw:daily (one rolled-up daily bar).
      expect(h.xAdd).toHaveBeenCalledTimes(1);
      const [, stream, payload] = h.xAdd.mock.calls[0]!;
      expect(stream).toBe('market:raw:daily');
      expect(payload).toHaveLength(1);
      expect(payload[0]).toMatchObject({ ticker: 'AAPL_US_EQ', interval: 'daily' });
    } finally {
      if (prev === undefined) delete process.env.BARS_BACKEND; else process.env.BARS_BACKEND = prev;
    }
  });

  it('publishes from Timescale bars even when the Mongo ohlcv_bars collection is empty', async () => {
    const prev = process.env.BARS_BACKEND;
    process.env.BARS_BACKEND = 'timescale';
    try {
      // The reader (Timescale) returns bars; an empty Mongo collection would have starved the old
      // direct read. The emit must still publish — proving the read no longer depends on Mongo.
      h.recentBars.mockImplementation(async () => [doc('AAPL', 'US', UTC_MIDNIGHT + 14 * 3_600_000, 100)].map(docToBar));
      const redis = fakeRedis();

      await maybeEmitDailyAtClose(redis as any, { US: ['AAPL_US_EQ'], LSE: [] }, 6, ALL_STATES);

      expect(h.xAdd).toHaveBeenCalledTimes(1);
      expect(h.xAdd.mock.calls[0]![1]).toBe('market:raw:daily');
      expect(redis.store.has(US_GATE)).toBe(true);     // emit succeeded → gate retained for the day
    } finally {
      if (prev === undefined) delete process.env.BARS_BACKEND; else process.env.BARS_BACKEND = prev;
    }
  });
});
