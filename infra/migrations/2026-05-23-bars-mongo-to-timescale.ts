/**
 * Mongo → Timescale bar backfill. One-shot, idempotent online migration that
 * copies every row of Mongo's `ohlcv_bars` collection into the Timescale `bars`
 * hypertable, plus every row of `bar_revisions_log` into the Timescale audit
 * twin. Designed to run after the bi-temporal-bars migration
 * (2026-05-15-bi-temporal-bars.ts) so all source rows already carry
 * observation_ts / knowledge_ts / content_hash / is_superseded.
 *
 * Idempotent: INSERT … ON CONFLICT DO NOTHING on the PG side. The hypertable's
 * primary key (ticker, observation_ts, interval, knowledge_ts) is what triggers
 * the conflict — re-running this script copies only the rows that aren't yet in
 * Timescale.
 *
 * Streaming: pulls Mongo in 10 000-row chunks; each chunk is dispatched as a
 * single PG INSERT … VALUES (...), (...), ... (multi-row INSERT). Keeps memory
 * bounded on populated clusters; one network round-trip per chunk.
 *
 * Run:
 *   MONGODB_URL=mongodb://trader:<pw>@host:27017/trader \
 *   TIMESCALE_URL=postgresql://trader:<pw>@host:5432/trader_ts \
 *     pnpm tsx infra/migrations/2026-05-23-bars-mongo-to-timescale.ts
 *
 * Order: run this AFTER deploying the new TimescaleDB chart + the
 * timescale-init Helm hook job (which creates the schema). Run BEFORE flipping
 * `BARS_BACKEND=timescale` so post-cutover reads return historical bars rather
 * than just the new dual-write window.
 *
 * See agent-docs/plans/three-database-split.md §Migration timeline.
 */

import { MongoClient } from 'mongodb';
import pg from 'pg';

const MONGO_URI    = process.env.MONGODB_URL  ?? process.env.MONGO_URI ?? 'mongodb://localhost:27017';
const MONGO_DB     = process.env.MONGODB_DB   ?? process.env.MONGO_DB  ?? 'trader';
const TIMESCALE_URL = process.env.TIMESCALE_URL ?? 'postgresql://trader:trader@localhost:5432/trader_ts';

const CHUNK_SIZE = 10_000;

interface BarDoc {
  ticker:           string;
  observation_ts:   number;
  knowledge_ts:     number;
  interval:         string;
  open:             number;
  high:             number;
  low:              number;
  close:            number;
  volume:           number;
  rawClose?:        number;
  adjustedClose?:   number;
  adjustmentFactor?:number;
  currency?:        string;
  content_hash:     string;
  is_superseded:    boolean;
}

interface AuditDoc {
  ticker:         string;
  observation_ts: number;
  interval:       string;
  knowledge_ts:   number;
  prior_hash?:    string | null;
  new_hash:       string;
  loggedAt?:      Date;
}

async function copyBars(mongo: MongoClient, pgPool: pg.Pool): Promise<{ scanned: number; inserted: number; skipped: number }> {
  const coll = mongo.db(MONGO_DB).collection<BarDoc>('ohlcv_bars');
  // Only pull rows that completed the bi-temporal migration — sourcing rows
  // without observation_ts would fail the PG NOT NULL constraint and stall the
  // migration. Operator must run 2026-05-15-bi-temporal-bars.ts first.
  const cursor = coll.find({ observation_ts: { $exists: true } });

  let scanned = 0, inserted = 0, skipped = 0;
  while (await cursor.hasNext()) {
    const chunk: BarDoc[] = [];
    while (await cursor.hasNext() && chunk.length < CHUNK_SIZE) {
      const doc = await cursor.next();
      if (doc) chunk.push(doc);
    }
    if (chunk.length === 0) break;
    scanned += chunk.length;

    // Build multi-row INSERT. Parameters: 14 per row. PostgreSQL parameter
    // limit is 65535, so 10k rows × 14 = 140k → would exceed. Split into
    // sub-batches of 4_000 rows × 14 = 56k params, safely below the cap.
    const SUB_BATCH = 4_000;
    for (let i = 0; i < chunk.length; i += SUB_BATCH) {
      const slice = chunk.slice(i, i + SUB_BATCH);
      const rows: unknown[] = [];
      const placeholders: string[] = [];
      slice.forEach((b, idx) => {
        const base = idx * 14;
        placeholders.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14})`,
        );
        // Default raw_close to close when the source row didn't persist it
        // (legacy rows before the FX work) — matches the live writer's behaviour.
        const rawClose = typeof b.rawClose === 'number' ? b.rawClose : b.close;
        rows.push(
          b.ticker, b.observation_ts, b.knowledge_ts, b.interval,
          b.open, b.high, b.low, b.close, b.volume,
          rawClose,
          b.adjustedClose ?? null,
          b.adjustmentFactor ?? null,
          b.currency ?? null,
          b.content_hash,
        );
      });
      const sql = `INSERT INTO bars
        (ticker, observation_ts, knowledge_ts, interval,
         open, high, low, close, volume,
         raw_close, adjusted_close, adjustment_factor, currency,
         content_hash)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (ticker, observation_ts, interval, knowledge_ts) DO NOTHING`;
      const result = await pgPool.query(sql, rows);
      const insertedHere = result.rowCount ?? 0;
      inserted += insertedHere;
      skipped  += slice.length - insertedHere;
    }
    process.stdout.write(`\r[migration] bars: scanned=${scanned} inserted=${inserted} skipped=${skipped}`);
  }
  process.stdout.write('\n');
  // Also handle is_superseded — it's NOT NULL with default FALSE, and we want
  // to preserve the source's value. The INSERT above relies on the default; for
  // any row that was superseded in Mongo we need a follow-up UPDATE.
  // Realistically: the Mongo writer sets is_superseded:true on the prior row
  // when a revision lands. We need to mirror that state in Timescale.
  console.log('[migration] mirroring is_superseded flags from Mongo …');
  const supersededCursor = coll.find(
    { observation_ts: { $exists: true }, is_superseded: true },
    { projection: { ticker: 1, observation_ts: 1, interval: 1, knowledge_ts: 1 } },
  );
  let updates = 0;
  while (await supersededCursor.hasNext()) {
    const doc = await supersededCursor.next();
    if (!doc) break;
    const r = await pgPool.query(
      `UPDATE bars SET is_superseded = TRUE
        WHERE ticker = $1 AND observation_ts = $2 AND interval = $3 AND knowledge_ts = $4`,
      [doc.ticker, doc.observation_ts, doc.interval, doc.knowledge_ts],
    );
    updates += r.rowCount ?? 0;
  }
  console.log(`[migration] superseded flag mirrored: ${updates} rows`);

  return { scanned, inserted, skipped };
}

async function copyAuditLog(mongo: MongoClient, pgPool: pg.Pool): Promise<{ scanned: number; inserted: number; skipped: number }> {
  const coll = mongo.db(MONGO_DB).collection<AuditDoc>('bar_revisions_log');
  const cursor = coll.find({});

  let scanned = 0, inserted = 0, skipped = 0;
  while (await cursor.hasNext()) {
    const chunk: AuditDoc[] = [];
    while (await cursor.hasNext() && chunk.length < CHUNK_SIZE) {
      const doc = await cursor.next();
      if (doc) chunk.push(doc);
    }
    if (chunk.length === 0) break;
    scanned += chunk.length;

    const SUB_BATCH = 8_000;  // 6 params per row → 48k well under cap
    for (let i = 0; i < chunk.length; i += SUB_BATCH) {
      const slice = chunk.slice(i, i + SUB_BATCH);
      const rows: unknown[] = [];
      const placeholders: string[] = [];
      slice.forEach((a, idx) => {
        const base = idx * 6;
        placeholders.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`);
        rows.push(
          a.ticker, a.observation_ts, a.interval, a.knowledge_ts,
          a.prior_hash ?? null,
          a.new_hash,
        );
      });
      const sql = `INSERT INTO bar_revisions_log
        (ticker, observation_ts, interval, knowledge_ts, prior_hash, new_hash)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (ticker, observation_ts, interval, knowledge_ts) DO NOTHING`;
      const result = await pgPool.query(sql, rows);
      const insertedHere = result.rowCount ?? 0;
      inserted += insertedHere;
      skipped  += slice.length - insertedHere;
    }
    process.stdout.write(`\r[migration] audit:  scanned=${scanned} inserted=${inserted} skipped=${skipped}`);
  }
  process.stdout.write('\n');

  return { scanned, inserted, skipped };
}

async function reportFinalState(mongo: MongoClient, pgPool: pg.Pool): Promise<void> {
  const barsMongo = await mongo.db(MONGO_DB).collection('ohlcv_bars').countDocuments({ observation_ts: { $exists: true } });
  const auditMongo = await mongo.db(MONGO_DB).collection('bar_revisions_log').countDocuments({});
  const { rows: barsPg } = await pgPool.query<{ n: string }>("SELECT count(*)::text AS n FROM bars");
  const { rows: auditPg } = await pgPool.query<{ n: string }>("SELECT count(*)::text AS n FROM bar_revisions_log");

  console.log('[migration] final state:');
  console.log(`  bars  — Mongo: ${barsMongo}   Timescale: ${barsPg[0]?.n}`);
  console.log(`  audit — Mongo: ${auditMongo}  Timescale: ${auditPg[0]?.n}`);

  if (Number(barsPg[0]?.n) < barsMongo) {
    console.warn('[migration] WARNING: Timescale bars row-count < Mongo. Rerun to capture any rows added since last sweep.');
    process.exit(2);
  }
}

async function main(): Promise<void> {
  console.log(`[migration] mongo=${MONGO_URI} db=${MONGO_DB}`);
  console.log(`[migration] timescale=${TIMESCALE_URL.replace(/:[^@/]*@/, ':***@')}`);

  const mongo  = new MongoClient(MONGO_URI);
  const pgPool = new pg.Pool({ connectionString: TIMESCALE_URL });

  try {
    await mongo.connect();

    // Sanity — fail fast if the destination schema isn't in place.
    const { rows } = await pgPool.query<{ to_regclass: string | null }>(
      "SELECT to_regclass('public.bars')::text AS to_regclass",
    );
    if (!rows[0]?.to_regclass) {
      console.error('[migration] FATAL: Timescale `bars` hypertable not found. Run shared-pg migrations first (timescale-init Helm hook job, or manual `runMigrations()` call).');
      process.exit(1);
    }

    const barsStats  = await copyBars(mongo, pgPool);
    const auditStats = await copyAuditLog(mongo, pgPool);
    console.log(`[migration] bars  — scanned=${barsStats.scanned}  inserted=${barsStats.inserted}  skipped=${barsStats.skipped}`);
    console.log(`[migration] audit — scanned=${auditStats.scanned} inserted=${auditStats.inserted} skipped=${auditStats.skipped}`);

    await reportFinalState(mongo, pgPool);
    console.log('[migration] ✅ complete');
  } finally {
    await mongo.close();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error('[migration] FATAL', err);
  process.exit(1);
});
