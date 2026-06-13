// Tests for writeBarRevisions — the bi-temporal write contract from
// agent-docs/plans/point-in-time-bar-history.md.
//
// Coverage:
//   • First insert: no prior row → one new row written, audit row with prior_hash:null.
//   • Idempotent re-poll: identical content_hash → zero writes, zero audit rows.
//   • Revision: differing content → atomic supersede + insert + audit.
//   • Mixed batch: mix of skips, first-prints, and revisions accounted correctly in stats.

process.env.INTERNAL_SECRET = 'test-internal-secret';

import { describe, it, expect, vi, beforeEach } from "vitest";
import { hashBarContent } from '@trader/shared-bars';
import type { OHLCVBar } from '@trader/shared-types';

// Mock getMongoClient: the writer uses it to start a transaction session. The stub
// session executes its withTransaction callback directly — no real transaction
// semantics needed for these unit tests; we're testing the writer's decision tree,
// not Mongo's transaction guarantees.
const sessionStub = {
  withTransaction: vi.fn(async (fn: () => Promise<void>) => { await fn(); }),
  endSession: vi.fn(async () => {}),
};
const clientStub = { startSession: () => sessionStub };

vi.mock('@trader/shared-mongo', async () => {
  const actual = await vi.importActual<typeof import('@trader/shared-mongo')>('@trader/shared-mongo');
  return {
    ...actual,
    getMongoClient: vi.fn(async () => clientStub as unknown as import('mongodb').MongoClient),
  };
});

// Mock the PG writer so dual-write tests can exercise the orchestration without
// a real Timescale. Default behaviour: succeeds with zero-stats. Individual
// tests override via mockResolvedValueOnce/mockRejectedValueOnce. vi.hoisted is
// required because vi.mock factories are hoisted to the top of the file, before
// regular `const` declarations evaluate.
const { pgWriteMock } = vi.hoisted(() => ({
  pgWriteMock: vi.fn(async () => ({ attempted: 0, inserted: 0, revisions: 0, skipped: 0 })),
}));
vi.mock('../modules/bars/infrastructure/pg-bar-writer.ts', () => ({
  writeBarRevisionsPg: pgWriteMock,
}));

import { writeBarRevisions } from '../modules/bars/infrastructure/persist-bars.ts';

// In-memory Mongo collection stub that records every mutation the writer issues.
// `priorByKey` seeds the latest-unsuperseded-row lookup so a test can simulate
// "what's already in Mongo" without a real database.
function makeCollections(priorByKey: Record<string, { content_hash: string }> = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const audits: Array<Record<string, unknown>> = [];

  const ohlcv = {
    find: (filter: { $or: Array<{ symbol: string; market: string; observation_ts: number }> }) => {
      // The writer queries `find({ $or: keys, is_superseded: false })` where each key is now keyed on
      // the bare identity (symbol, market). Return any prior rows the test pre-seeded for those keys
      // (priorByKey is keyed `symbol|market|observation_ts`).
      const matched: Array<Record<string, unknown>> = [];
      for (const k of filter.$or) {
        const key = `${k.symbol}|${k.market}|${k.observation_ts}`;
        const prior = priorByKey[key];
        if (prior) matched.push({ symbol: k.symbol, market: k.market, observation_ts: k.observation_ts, content_hash: prior.content_hash });
      }
      return {
        project: () => ({ toArray: async () => matched }),
        toArray: async () => matched,
      };
    },
    updateMany: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      updates.push({ filter, update });
      return { acknowledged: true, modifiedCount: 1 };
    },
    insertOne: async (doc: Record<string, unknown>) => {
      inserts.push(doc);
      return { acknowledged: true, insertedId: 'fake' };
    },
  };
  const audit = {
    insertOne: async (doc: Record<string, unknown>) => {
      audits.push(doc);
      return { acknowledged: true, insertedId: 'fake' };
    },
  };

  const db = {
    collection: (name: string) => name === 'ohlcv_bars' ? ohlcv : audit,
  } as unknown as import('mongodb').Db;
  return { db, inserts, updates, audits };
}

function bar(ticker: string, obs: number, close: number, overrides: Partial<OHLCVBar> = {}): OHLCVBar {
  return {
    ticker,
    observation_ts: obs,
    timestamp:      obs,
    interval:       '5m',
    open:  close, high: close + 0.5, low: close - 0.5, close,
    volume: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStub.withTransaction.mockClear();
  sessionStub.endSession.mockClear();
});

describe('writeBarRevisions — first insert (no prior row)', () => {
  it('inserts the row with knowledge_ts + is_superseded:false and writes an audit entry with prior_hash:null', async () => {
    const { db, inserts, updates, audits } = makeCollections({});
    const now = 1_700_000_000_000;
    const b = bar('A_US_EQ', 1_000, 100);
    const stats = await writeBarRevisions(db, [b], '5m', now);

    expect(stats).toEqual({ attempted: 1, inserted: 1, revisions: 0, skipped: 0 });
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(0);                  // no prior row to supersede
    expect(inserts[0]).toMatchObject({
      symbol: 'A',
      market: 'US',
      observation_ts: 1_000,
      knowledge_ts: now,
      interval: '5m',
      is_superseded: false,
      close: 100,
    });
    expect(inserts[0].content_hash).toBe(hashBarContent(b));

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      symbol: 'A',
      market: 'US',
      observation_ts: 1_000,
      knowledge_ts: now,
      prior_hash: null,                                // first-print marker
      new_hash: hashBarContent(b),
    });
  });
});

describe('writeBarRevisions — idempotent re-poll', () => {
  it('skips bars whose content_hash matches the latest stored revision', async () => {
    const b = bar('A_US_EQ', 1_000, 100);
    const hash = hashBarContent(b);
    const { db, inserts, updates, audits } = makeCollections({ 'A|US|1000': { content_hash: hash } });

    const stats = await writeBarRevisions(db, [b], '5m');

    expect(stats).toEqual({ attempted: 1, inserted: 0, revisions: 0, skipped: 1 });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(audits).toHaveLength(0);
    // No session opened — cosmetic-skip-only batches don't pay transaction overhead.
    expect(sessionStub.withTransaction).not.toHaveBeenCalled();
    expect(sessionStub.endSession).not.toHaveBeenCalled();
  });

  it('skips multiple identical bars in one batch', async () => {
    const b1 = bar('A_US_EQ', 1_000, 100);
    const b2 = bar('A_US_EQ', 2_000, 200);
    const { db, inserts } = makeCollections({
      'A|US|1000': { content_hash: hashBarContent(b1) },
      'A|US|2000': { content_hash: hashBarContent(b2) },
    });

    const stats = await writeBarRevisions(db, [b1, b2], '5m');

    expect(stats.skipped).toBe(2);
    expect(stats.inserted).toBe(0);
    expect(inserts).toHaveLength(0);
  });
});

describe('writeBarRevisions — revision', () => {
  it('flips is_superseded:true on the prior row, inserts the new row, and audits with prior_hash set', async () => {
    const original = bar('A_US_EQ', 1_000, 100);
    const revised  = bar('A_US_EQ', 1_000, 101);      // same observation_ts, different close
    const priorHash = hashBarContent(original);
    const newHash   = hashBarContent(revised);
    expect(priorHash).not.toBe(newHash);              // sanity — the close differs

    const { db, inserts, updates, audits } = makeCollections({
      'A|US|1000': { content_hash: priorHash },
    });
    const now = 1_700_000_000_000;
    const stats = await writeBarRevisions(db, [revised], '5m', now);

    expect(stats).toEqual({ attempted: 1, inserted: 1, revisions: 1, skipped: 0 });

    // 1. Prior row superseded.
    expect(updates).toHaveLength(1);
    expect(updates[0].filter).toMatchObject({
      symbol: 'A',
      market: 'US',
      observation_ts: 1_000,
      interval: '5m',
      is_superseded: false,
    });
    expect(updates[0].update).toEqual({ $set: { is_superseded: true } });

    // 2. New revision inserted with the new content + the writer-stamped knowledge_ts.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      symbol: 'A',
      market: 'US',
      observation_ts: 1_000,
      knowledge_ts: now,
      is_superseded: false,
      close: 101,
      content_hash: newHash,
    });

    // 3. Audit entry references both hashes — the diff is what the operator dashboard
    //    needs to flag "Yahoo just revised this bar".
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      prior_hash: priorHash,
      new_hash:   newHash,
    });
  });
});

describe('writeBarRevisions — mixed batch', () => {
  it('correctly accounts skips, first-prints, and revisions in stats', async () => {
    // Three logical bars:
    //   A@1000: identical to prior → skip
    //   A@2000: no prior → first-print insert
    //   B@1000: prior exists with different hash → revision
    const skipBar     = bar('A_US_EQ', 1_000, 100);
    const newBar      = bar('A_US_EQ', 2_000, 200);
    const reviseBar   = bar('B_US_EQ', 1_000, 50);
    const skipHash    = hashBarContent(skipBar);
    const oldBHash    = hashBarContent(bar('B_US_EQ', 1_000, 49));   // close=49 — different from 50

    const { db, inserts, updates, audits } = makeCollections({
      'A|US|1000': { content_hash: skipHash },
      'B|US|1000': { content_hash: oldBHash },
    });

    const stats = await writeBarRevisions(db, [skipBar, newBar, reviseBar], '5m');

    expect(stats.attempted).toBe(3);
    expect(stats.skipped).toBe(1);
    expect(stats.inserted).toBe(2);
    expect(stats.revisions).toBe(1);

    // Two inserts (newBar, reviseBar) and one supersede (reviseBar's prior).
    expect(inserts).toHaveLength(2);
    expect(updates).toHaveLength(1);
    expect(audits).toHaveLength(2);
    // The audit for B records the prior hash (oldBHash); the audit for A@2000 is null.
    const audit_B = audits.find((a) => a.symbol === 'B');
    expect(audit_B?.prior_hash).toBe(oldBHash);
    const audit_A_new = audits.find((a) => a.symbol === 'A' && a.observation_ts === 2_000);
    expect(audit_A_new?.prior_hash).toBeNull();
  });
});

describe('writeBarRevisions — dual-write to Timescale', () => {
  beforeEach(() => {
    pgWriteMock.mockClear();
    pgWriteMock.mockResolvedValue({ attempted: 0, inserted: 0, revisions: 0, skipped: 0 });
  });

  it('skips the PG writer entirely when DUAL_WRITE_BARS is unset', async () => {
    delete process.env.DUAL_WRITE_BARS;
    const { db } = makeCollections({});
    await writeBarRevisions(db, [bar('A_US_EQ', 1_000, 100)], '5m');
    expect(pgWriteMock).not.toHaveBeenCalled();
  });

  it('calls the PG writer after a successful Mongo write when DUAL_WRITE_BARS=true', async () => {
    process.env.DUAL_WRITE_BARS = 'true';
    try {
      const { db, inserts } = makeCollections({});
      const b = bar('A_US_EQ', 1_000, 100);
      const now = 1_700_000_000_000;
      await writeBarRevisions(db, [b], '5m', now);

      // Mongo write happened.
      expect(inserts).toHaveLength(1);
      // PG writer invoked with the same bars + interval + now.
      expect(pgWriteMock).toHaveBeenCalledTimes(1);
      expect(pgWriteMock).toHaveBeenCalledWith([b], '5m', now);
    } finally {
      delete process.env.DUAL_WRITE_BARS;
    }
  });

  it('does NOT fail the Mongo write when the PG writer throws — logs to dual_write_failures instead', async () => {
    process.env.DUAL_WRITE_BARS = 'true';
    try {
      pgWriteMock.mockRejectedValueOnce(new Error('timescale unreachable'));

      // Custom db stub that tracks the dual_write_failures collection separately
      // — makeCollections's `collection(name)` routes only ohlcv_bars and
      // bar_revisions_log, so we extend it.
      const baseFactory = makeCollections({});
      const dualInserts: Array<Record<string, unknown>> = [];
      const dualWriteFailuresColl = {
        insertOne: async (doc: Record<string, unknown>) => {
          dualInserts.push(doc);
          return { acknowledged: true, insertedId: 'fake' };
        },
      };
      const baseDb = baseFactory.db as unknown as {
        collection: (n: string) => unknown;
      };
      const wrappedDb = {
        collection: (name: string) => name === 'dual_write_failures'
          ? dualWriteFailuresColl
          : baseDb.collection(name),
      } as unknown as import('mongodb').Db;

      // Mongo write must succeed despite PG failure.
      const stats = await writeBarRevisions(wrappedDb, [bar('A_US_EQ', 1_000, 100)], '5m');
      expect(stats.inserted).toBe(1);

      // Failure row written. The dual-write failure log records the in-memory OHLCVBar.ticker
      // (still the T212 form — the failure log is operator-facing diagnostics, not storage).
      expect(dualInserts).toHaveLength(1);
      expect(dualInserts[0]).toMatchObject({
        tickers: ['A_US_EQ'],
        observation_ts_range: [1_000, 1_000],
        interval: '5m',
      });
      expect(typeof dualInserts[0]?.error).toBe('string');
      expect(dualInserts[0]?.error).toMatch(/timescale unreachable/);
    } finally {
      delete process.env.DUAL_WRITE_BARS;
    }
  });
});

describe('writeBarRevisions — defensive guards', () => {
  it('returns zero-stats for empty input without touching Mongo', async () => {
    const { db, inserts } = makeCollections({});
    const stats = await writeBarRevisions(db, [], '5m');
    expect(stats).toEqual({ attempted: 0, inserted: 0, revisions: 0, skipped: 0 });
    expect(inserts).toHaveLength(0);
  });

  it('drops bars with non-finite observation_ts (defensive — should not happen post-typecheck but worth pinning)', async () => {
    const { db, inserts } = makeCollections({});
    const bad = { ...bar('A_US_EQ', 1_000, 100), observation_ts: Number.NaN };
    const stats = await writeBarRevisions(db, [bad as OHLCVBar], '5m');
    expect(stats.attempted).toBe(1);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(inserts).toHaveLength(0);
  });
});
