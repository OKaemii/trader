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

// Hoisted mutable state the mocks read (vi.mock factories are hoisted above imports).
const h = vi.hoisted(() => ({ docs: [] as any[], xAdd: vi.fn(async () => {}) }));

vi.mock('@trader/shared-mongo', async (orig) => ({
  ...(await orig() as any),
  getMongoDb: async () => ({
    collection: () => ({ find: () => ({ toArray: async () => h.docs }) }),
  }),
}));
vi.mock('@trader/shared-redis', async (orig) => ({
  ...(await orig() as any),
  xAdd: (...a: any[]) => h.xAdd(...a),
}));
vi.mock('../modules/bars/infrastructure/persist-bars.ts', async (orig) => ({
  ...(await orig() as any),
  writeBarRevisions: async () => ({ attempted: 0, inserted: 0, revisions: 0, skipped: 0 }),
}));
vi.mock('@trader/shared-bars', async (orig) => ({
  ...(await orig() as any),
  invalidateBarsBulk: async () => {},
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

function doc(ticker: string, ts: number, close: number) {
  return { ticker, observation_ts: ts, interval: '5m', open: close, high: close, low: close, close, volume: 100 };
}

beforeEach(() => {
  h.docs = [];
  h.xAdd.mockClear();
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
      doc('AAPL_US_EQ', UTC_MIDNIGHT + 14 * 3_600_000, 100),
      doc('AAPL_US_EQ', UTC_MIDNIGHT + 14 * 3_600_000 + 60_000, 101),
    ];
    const redis = fakeRedis();

    await maybeEmitDailyAtClose(redis as any, { US: ['AAPL_US_EQ'], LSE: [] }, 3, ALL_STATES);

    expect(h.xAdd).toHaveBeenCalledTimes(1);           // market:raw:daily published
    expect(redis.del).not.toHaveBeenCalled();          // gate NOT released — the day's emit is done
    expect(redis.store.has(US_GATE)).toBe(true);       // held for the rest of the UTC day
  });

  it('a burned gate from a prior emit blocks a duplicate emit (NX is load-bearing)', async () => {
    h.docs = [doc('AAPL_US_EQ', UTC_MIDNIGHT + 14 * 3_600_000, 100)];
    const redis = fakeRedis();
    redis.store.set(US_GATE, '1');                     // already emitted earlier this UTC day

    await maybeEmitDailyAtClose(redis as any, { US: ['AAPL_US_EQ'], LSE: [] }, 4, ALL_STATES);

    expect(h.xAdd).not.toHaveBeenCalled();             // NX blocked the second emit
  });
});
