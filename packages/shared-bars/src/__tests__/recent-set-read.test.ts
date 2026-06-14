// Tests for getRecentBarsForTickers — the BARS_BACKEND-dispatched SET reader that returns the latest
// unsuperseded `interval` bars at/after `sinceTs` for a SET of (symbol, market) identities. It is the
// multi-ticker read the daily-emit fold needs ("every active-universe ticker's 5m bars since
// UTC-midnight"); the per-ticker getBars / single-bar getBarAtOrBefore don't fit.
//
// The load-bearing guarantees this file pins:
//   • Mongo↔pg PARITY — the same identity set + sinceTs returns the same bars (by content) from both
//     backends, so the cutover (Mongo → Timescale) is read-side indistinguishable.
//   • Bounded read — the read is floored at `observation_ts >= sinceTs`, so on a many-chunk hypertable
//     it prunes to a slice of chunks and does NOT exhaust the lock table; an UNBOUNDED set read over
//     the same deep series MUST OOM (the regression the bars-OOM work fights, re-asserted for the set
//     form). Proven against a real TimescaleDB testcontainer with a tight lock budget.
//   • Set membership + floor — only requested identities come back; a bar older than sinceTs is
//     excluded; an empty id set short-circuits to [] with no query.
//   • Dispatcher — routes mongo vs timescale by BARS_BACKEND; db=undefined on the mongo default throws.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { closePgPool, getPgPool, runMigrations } from '@trader/shared-pg';
import type { TickerIdentity } from '@trader/ticker-identity';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRecentBarsForTickers } from '../index.ts';

const dockerAvailable = await isDockerAvailable();
const TEST_TIMEOUT_MS = 120_000;
const day = 24 * 60 * 60 * 1000;

// In-memory Redis stub — the SET reader doesn't cache, so this only proves it is never written.
function makeRedis() {
  const store = new Map<string, string>();
  const calls: Array<{ op: 'get' | 'setEx'; key: string }> = [];
  return {
    store, calls,
    get: async (key: string) => { calls.push({ op: 'get', key }); return store.get(key) ?? null; },
    setEx: async (key: string, _ttl: number, value: string) => {
      calls.push({ op: 'setEx', key });
      store.set(key, value);
      return 'OK' as const;
    },
  };
}

// In-memory Mongo collection: enough of find().sort().toArray() to exercise the SET reader's Mongo
// branch, including the `$or:[{symbol,market}…]` membership match it uses. Records find filters.
function makeCollectionWith(docs: Array<Record<string, unknown>>) {
  const findFilters: Array<Record<string, unknown>> = [];
  return {
    findFilters,
    find: (filter: Record<string, unknown>) => {
      findFilters.push(filter);
      let matched = docs.filter((d) => matchFilter(d, filter));
      let sortSpec: Record<string, number> | null = null;
      const cursor = {
        sort: (s: Record<string, number>) => { sortSpec = s; return cursor; },
        toArray: async () => {
          if (sortSpec) matched = sortDocs(matched, sortSpec);
          return matched;
        },
      };
      return cursor;
    },
  };
}

function sortDocs(docs: Array<Record<string, unknown>>, spec: Record<string, number>): Array<Record<string, unknown>> {
  const keys = Object.entries(spec);
  return docs.slice().sort((a, b) => {
    for (const [k, dir] of keys) {
      const av = a[k]; const bv = b[k];
      if (av === bv) continue;
      return (av! > bv! ? 1 : -1) * dir;
    }
    return 0;
  });
}

// Supports the SET reader's filter shape: top-level equality, `observation_ts:{$gte}`, and the
// `$or:[{symbol,market}…]` membership clause.
function matchFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$or') {
      const clauses = v as Array<Record<string, unknown>>;
      if (!clauses.some((c) => matchFilter(doc, c))) return false;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const ops = v as Record<string, unknown>;
      if ('$gte' in ops && !(typeof doc[k] === 'number' && (doc[k] as number) >= (ops.$gte as number))) return false;
      if ('$gt'  in ops && !(typeof doc[k] === 'number' && (doc[k] as number) >  (ops.$gt  as number))) return false;
      if ('$lte' in ops && !(typeof doc[k] === 'number' && (doc[k] as number) <= (ops.$lte as number))) return false;
    } else if (doc[k] !== v) {
      return false;
    }
  }
  return true;
}

function makeDb(coll: ReturnType<typeof makeCollectionWith>) {
  return { collection: () => coll } as never;
}

const _now = Date.now();
const utcMidnight = Date.parse(`${new Date(_now).toISOString().slice(0, 10)}T00:00:00.000Z`);

// A Mongo doc as the live poll writes it (bare identity columns, number observation_ts, unsuperseded).
function mongoBar(symbol: string, market: string, obsTs: number, close: number, extra: Record<string, unknown> = {}) {
  return {
    symbol, market, observation_ts: obsTs, knowledge_ts: obsTs, interval: '5m',
    is_superseded: false, open: close, high: close, low: close, close, volume: 100, ...extra,
  };
}

const AAPL: TickerIdentity = { symbol: 'AAPL', market: 'US' };
const MSFT: TickerIdentity = { symbol: 'MSFT', market: 'US' };
const SHEL: TickerIdentity = { symbol: 'SHEL', market: 'LSE' };

describe('getRecentBarsForTickers — Mongo branch', () => {
  it('returns the set\'s unsuperseded bars at/after sinceTs, sorted oldest-first', async () => {
    delete process.env.BARS_BACKEND;
    const coll = makeCollectionWith([
      mongoBar('AAPL', 'US', utcMidnight + 5 * 60_000, 10),
      mongoBar('AAPL', 'US', utcMidnight + 10 * 60_000, 11),
      mongoBar('MSFT', 'US', utcMidnight + 7 * 60_000, 20),
    ]);
    const bars = await getRecentBarsForTickers(makeRedis() as never, makeDb(coll), [AAPL, MSFT], {
      interval: '5m', sinceTs: utcMidnight,
    });
    expect(bars.map((b) => b.close)).toEqual([10, 20, 11]); // oldest-first across the set
    // The T212 ticker is re-derived from (symbol, market) on the way out.
    expect(new Set(bars.map((b) => b.ticker))).toEqual(new Set(['AAPL_US_EQ', 'MSFT_US_EQ']));
    // The filter is the lifted daily-emit query: $or membership + interval + is_superseded + $gte.
    const f = coll.findFilters[0] as {
      $or?: Array<{ symbol: string; market: string }>;
      interval?: string; is_superseded?: boolean; observation_ts?: { $gte: number };
    };
    expect(f.$or).toEqual([{ symbol: 'AAPL', market: 'US' }, { symbol: 'MSFT', market: 'US' }]);
    expect(f.interval).toBe('5m');
    expect(f.is_superseded).toBe(false);
    expect(f.observation_ts).toEqual({ $gte: utcMidnight });
  });

  it('excludes bars before sinceTs and bars for identities not in the set', async () => {
    delete process.env.BARS_BACKEND;
    const coll = makeCollectionWith([
      mongoBar('AAPL', 'US', utcMidnight - 5 * 60_000, 9),   // yesterday — before the floor
      mongoBar('AAPL', 'US', utcMidnight + 5 * 60_000, 10),  // today — kept
      mongoBar('SHEL', 'LSE', utcMidnight + 5 * 60_000, 30), // not in the requested set
    ]);
    const bars = await getRecentBarsForTickers(makeRedis() as never, makeDb(coll), [AAPL], {
      interval: '5m', sinceTs: utcMidnight,
    });
    expect(bars).toHaveLength(1);
    expect(bars[0]?.close).toBe(10);
    expect(bars[0]?.ticker).toBe('AAPL_US_EQ');
  });

  it('excludes superseded revisions (live fast lane only)', async () => {
    delete process.env.BARS_BACKEND;
    const obs = utcMidnight + 5 * 60_000;
    const coll = makeCollectionWith([
      mongoBar('AAPL', 'US', obs, 10, { is_superseded: true }),  // stale revision
      mongoBar('AAPL', 'US', obs, 12, { is_superseded: false }), // live revision
    ]);
    const bars = await getRecentBarsForTickers(makeRedis() as never, makeDb(coll), [AAPL], {
      interval: '5m', sinceTs: utcMidnight,
    });
    expect(bars).toHaveLength(1);
    expect(bars[0]?.close).toBe(12);
  });

  it('never writes the cache (this read is intentionally un-cached)', async () => {
    delete process.env.BARS_BACKEND;
    const coll = makeCollectionWith([mongoBar('AAPL', 'US', utcMidnight + 5 * 60_000, 10)]);
    const redis = makeRedis();
    await getRecentBarsForTickers(redis as never, makeDb(coll), [AAPL], { interval: '5m', sinceTs: utcMidnight });
    expect(redis.calls.filter((c) => c.op === 'setEx')).toHaveLength(0);
    expect(redis.calls.filter((c) => c.op === 'get')).toHaveLength(0);
  });

  it('short-circuits to [] for an empty id set without touching the collection', async () => {
    delete process.env.BARS_BACKEND;
    const coll = makeCollectionWith([mongoBar('AAPL', 'US', utcMidnight + 5 * 60_000, 10)]);
    const bars = await getRecentBarsForTickers(makeRedis() as never, makeDb(coll), [], { interval: '5m', sinceTs: utcMidnight });
    expect(bars).toEqual([]);
    expect(coll.findFilters).toHaveLength(0);
  });
});

describe('getRecentBarsForTickers — dispatcher', () => {
  it('throws when db is undefined and BARS_BACKEND defaults to mongo', async () => {
    delete process.env.BARS_BACKEND;
    await expect(
      getRecentBarsForTickers(makeRedis() as never, undefined, [AAPL], { interval: '5m', sinceTs: utcMidnight }),
    ).rejects.toThrow(/db parameter required/);
  });

  it('does NOT require db for an empty id set even on the mongo default (short-circuit first)', async () => {
    delete process.env.BARS_BACKEND;
    const bars = await getRecentBarsForTickers(makeRedis() as never, undefined, [], { interval: '5m', sinceTs: utcMidnight });
    expect(bars).toEqual([]);
  });
});

// ── Real Postgres parity + the bounded-read regression (Docker-gated) ──────────────────────────────
// Reuses the at-or-before testcontainer harness shape: a TimescaleDB container, the shared-pg
// migrations, BARS_BACKEND=timescale. Proves Mongo↔pg parity on one fixture set, and that the set read
// stays bounded on a many-chunk hypertable where an UNBOUNDED set read OOMs.

describe.skipIf(!dockerAvailable)('getRecentBarsForTickers — Mongo↔pg parity (real Postgres)', () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await new GenericContainer('timescale/timescaledb:2.17.2-pg16')
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'trader_ts' })
      .withExposedPorts(5432)
      .withCommand(['postgres', '-c', 'shared_preload_libraries=timescaledb'])
      .start();
    process.env.TIMESCALE_URL = `postgresql://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/trader_ts`;
    const pool = getPgPool();
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb'); break; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const sqlDir = path.resolve(thisDir, '..', '..', '..', 'shared-pg', 'sql');
    await runMigrations(sqlDir, pool);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await closePgPool();
    await container?.stop();
    delete process.env.BARS_BACKEND;
  }, TEST_TIMEOUT_MS);

  afterEach(async () => {
    const pool = getPgPool();
    await pool.query('TRUNCATE bars, bar_revisions_log');
  });

  it('returns the same set bars from pg as the Mongo branch (parity), across markets', async () => {
    const pool = getPgPool();
    // One fixture set spanning both markets, with: an in-window bar per name, a pre-floor bar (must be
    // excluded), a superseded revision (must be excluded), and a name not requested (must be excluded).
    const fixtures: Array<Record<string, unknown>> = [
      mongoBar('AAPL', 'US', utcMidnight + 5 * 60_000, 10),
      mongoBar('AAPL', 'US', utcMidnight + 10 * 60_000, 11),
      mongoBar('MSFT', 'US', utcMidnight + 7 * 60_000, 20),
      mongoBar('SHEL', 'LSE', utcMidnight + 6 * 60_000, 30),
      mongoBar('AAPL', 'US', utcMidnight - 5 * 60_000, 99),                       // before the floor
      mongoBar('MSFT', 'US', utcMidnight + 7 * 60_000, 21, { is_superseded: true }), // a stale revision (same obs)
      mongoBar('TSLA', 'US', utcMidnight + 5 * 60_000, 50),                       // not in the requested set
    ];
    for (const d of fixtures) {
      await pool.query(
        `INSERT INTO bars (symbol, market, observation_ts, knowledge_ts, interval,
                           open, high, low, close, volume, raw_close, content_hash, is_superseded)
         VALUES ($1, $2, $3, $4, '5m', $5, $5, $5, $5, $6, $5, $7, $8)`,
        [d.symbol, d.market, d.observation_ts, (d.knowledge_ts as number) + (d.is_superseded ? 1 : 0),
         d.close, d.volume, `h${d.symbol}${d.observation_ts}${d.is_superseded ? 's' : ''}`, d.is_superseded],
      );
    }
    const ids = [AAPL, MSFT, SHEL];
    const q = { interval: '5m' as const, sinceTs: utcMidnight };

    process.env.BARS_BACKEND = 'timescale';
    const pg = await getRecentBarsForTickers(makeRedis() as never, undefined, ids, q);

    delete process.env.BARS_BACKEND;
    const mongo = await getRecentBarsForTickers(makeRedis() as never, makeDb(makeCollectionWith(fixtures)), ids, q);

    // Same content from both stores. Compare on the stable identifying fields (ticker + obs + close),
    // sorted, so the two backends are read-side indistinguishable.
    const shape = (bars: ReadonlyArray<{ ticker: string; observation_ts: number; close: number }>) =>
      bars.map((b) => ({ ticker: b.ticker, observation_ts: b.observation_ts, close: b.close }))
        .sort((a, b) => a.observation_ts - b.observation_ts || a.ticker.localeCompare(b.ticker));

    expect(shape(pg)).toEqual(shape(mongo));
    // And the expected survivors only: the four in-window, live, requested bars (LSE re-derives to the
    // `SHELl_EQ` form, US to `_US_EQ`); no pre-floor AAPL, no superseded MSFT revision, no TSLA.
    expect(shape(pg)).toEqual(shape([
      { ticker: 'AAPL_US_EQ', observation_ts: utcMidnight + 5 * 60_000, close: 10 },
      { ticker: 'SHELl_EQ',   observation_ts: utcMidnight + 6 * 60_000, close: 30 },
      { ticker: 'MSFT_US_EQ', observation_ts: utcMidnight + 7 * 60_000, close: 20 },
      { ticker: 'AAPL_US_EQ', observation_ts: utcMidnight + 10 * 60_000, close: 11 },
    ]));
  }, TEST_TIMEOUT_MS);
});

// The bounded-read regression: a many-chunk bars hypertable (daily 2006→now, 7-day chunks ≈ 1000+
// chunks) makes an UNBOUNDED `(symbol,market) IN (…) ORDER BY observation_ts ASC` plan a Merge Append
// over EVERY chunk — the executor locks them all at startup → "out of shared memory" (SQLSTATE 53200,
// lock.c LockAcquireExtended) under a tight lock table. The new SET reader is floored at
// `observation_ts >= sinceTs`, so it prunes to the window's chunks and stays under the budget. We
// shrink max_locks_per_transaction × max_connections (16 × 10) to make ~1000 chunk locks overflow
// deterministically; the series is loaded in ≤90-day batches (each txn touches few chunks).
const OOM_MAX_LOCKS = 16;
const OOM_MAX_CONNECTIONS = 10;
const INSERT_BATCH_MS = 90 * day;

describe.skipIf(!dockerAvailable)('getRecentBarsForTickers — many-chunk bounded-read (OOM regression)', () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await new GenericContainer('timescale/timescaledb:2.17.2-pg16')
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'trader_ts' })
      .withExposedPorts(5432)
      // Small shared lock table — the whole point: locking ~1000 chunks in one plan must overflow it.
      .withCommand([
        'postgres',
        '-c', 'shared_preload_libraries=timescaledb',
        '-c', `max_locks_per_transaction=${OOM_MAX_LOCKS}`,
        '-c', `max_connections=${OOM_MAX_CONNECTIONS}`,
      ])
      .start();
    process.env.TIMESCALE_URL = `postgresql://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/trader_ts`;
    const pool = getPgPool();
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb'); break; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const sqlDir = path.resolve(thisDir, '..', '..', '..', 'shared-pg', 'sql');
    await runMigrations(sqlDir, pool);

    // Deep daily series 2006-01-01 → now for AAPL (7-day chunks ⇒ ~1000+ chunks), inserted in ≤90-day
    // batches so each transaction touches ~13 chunks (fits the tight lock budget); a single all-chunk
    // INSERT would itself overflow it. The SET reader will be asked for the most-recent day only.
    const startTs = Date.UTC(2006, 0, 1);
    const endTs = Date.now();
    for (let lo = startTs; lo < endTs; lo += INSERT_BATCH_MS) {
      const hi = Math.min(lo + INSERT_BATCH_MS - day, endTs);
      await pool.query(
        `INSERT INTO bars (symbol, market, observation_ts, knowledge_ts, interval,
                           open, high, low, close, volume, raw_close, content_hash, is_superseded)
         SELECT 'AAPL', 'US', g, g, 'daily', 10, 10, 10, 10, 1000, 10, 'h' || g::text, FALSE
           FROM generate_series($1::bigint, $2::bigint, $3::bigint) AS g`,
        [lo, hi, day],
      );
    }
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await closePgPool();
    await container?.stop();
    delete process.env.BARS_BACKEND;
  }, TEST_TIMEOUT_MS);

  it('the hypertable really spans many chunks (the OOM precondition)', async () => {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM timescaledb_information.chunks WHERE hypertable_name = 'bars'`,
    );
    expect(rows[0].n).toBeGreaterThan(200);
  });

  it('an UNBOUNDED set read (no observation_ts floor) exhausts the lock table — the regression', async () => {
    const pool = getPgPool();
    // The shape WITHOUT the `observation_ts >= sinceTs` floor the SET reader carries: its plan is a
    // Merge Append over every chunk's index scan; the executor locks them all → "out of shared memory"
    // (SQLSTATE 53200). This is the assertion that the floor is load-bearing — remove it and the real
    // reader fails here too.
    await expect(
      pool.query(
        `SELECT symbol, market, observation_ts, close
           FROM bars
          WHERE (symbol, market) IN (($1, $2))
            AND interval = $3 AND is_superseded = FALSE
          ORDER BY observation_ts ASC`,
        ['AAPL', 'US', 'daily'],
      ),
    ).rejects.toMatchObject({ code: '53200' });
  });

  it('the bounded getRecentBarsForTickers returns the recent window WITHOUT OOMing', async () => {
    process.env.BARS_BACKEND = 'timescale';
    // Ask for only the last ~3 days (the daily-emit shape: today's bars). The floor prunes the plan to
    // the recent chunks, so the read the unbounded query above could not complete returns cleanly.
    const sinceTs = Date.now() - 3 * day;
    const bars = await getRecentBarsForTickers(makeRedis() as never, undefined, [AAPL], { interval: 'daily', sinceTs });
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.length).toBeLessThan(10);               // bounded — not the whole 2006→now series
    for (const b of bars) {
      expect(b.observation_ts).toBeGreaterThanOrEqual(sinceTs);
      expect(b.ticker).toBe('AAPL_US_EQ');
    }
  }, TEST_TIMEOUT_MS);

  it('EXPLAIN of the bounded set read prunes to a bounded chunk count (not the whole hypertable)', async () => {
    const pool = getPgPool();
    const { rows: totalRows } = await pool.query(
      `SELECT count(*)::int AS n FROM timescaledb_information.chunks WHERE hypertable_name = 'bars'`,
    );
    const totalChunks = totalRows[0].n as number;
    const sinceTs = Date.now() - 3 * day;
    const { rows } = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       SELECT symbol, market, observation_ts, close
         FROM bars
        WHERE (symbol, market) IN (($1, $2))
          AND interval = $3 AND is_superseded = FALSE AND observation_ts >= $4
        ORDER BY observation_ts ASC`,
      ['AAPL', 'US', 'daily', sinceTs],
    );
    const plan = rows.map((r) => r['QUERY PLAN'] as string).join('\n');
    const chunkScans = (plan.match(/_hyper_\d+_\d+_chunk/g) ?? []).length;
    // A 3-day window touches ~1 chunk; assert chunk exclusion pruned to a small slice of the ~1000 total.
    expect(chunkScans).toBeLessThan(totalChunks / 3);
  });
});

async function isDockerAvailable(): Promise<boolean> {
  try {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 3000 });
    return result.status === 0;
  } catch {
    return false;
  }
}
