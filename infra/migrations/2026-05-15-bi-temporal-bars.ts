/**
 * Bi-temporal bars migration. One-shot, idempotent online migration that:
 *
 *   1. Adds `observation_ts`, `knowledge_ts`, `content_hash`, `is_superseded`
 *      columns to every existing `ohlcv_bars` row.
 *   2. Creates the new bi-temporal indexes:
 *        - `bar_btemporal_unique`    — { ticker, observation_ts, interval, knowledge_ts } unique
 *        - `bar_latest_unique`       — { ticker, observation_ts, interval } partial-unique is_superseded:false
 *        - `bar_knowledge_lookup`    — { ticker, knowledge_ts }
 *   3. Drops the legacy `ticker_timestamp_interval_unique` index (which collides
 *      every new insert on null because new writes don't set `timestamp`).
 *
 * Rerunning is a no-op:
 *   - Rows already carrying `observation_ts` are skipped by the backfill match.
 *   - Index `createIndex` is idempotent when the spec matches.
 *   - Dropping the legacy index is wrapped in try/catch.
 *
 * Run:
 *   MONGODB_URL=mongodb://trader:<pw>@host:27017/trader pnpm tsx infra/migrations/2026-05-15-bi-temporal-bars.ts
 *
 * Replica set requirement: the new writer uses multi-document transactions which
 * require a replica set. The script asserts replica-set membership before
 * proceeding; on a standalone Mongo it exits with a clear error.
 *
 * Why this is a separate script (not bundled into market-data-service boot):
 *   - The data backfill is O(rows) and can take minutes on a populated cluster;
 *     blocking the pollLoop's first iteration on it is unacceptable.
 *   - The legacy-index drop is a destructive operation that benefits from an
 *     operator-visible runbook entry rather than silent boot-time behaviour.
 *
 * See agent-docs/plans/point-in-time-bar-history.md.
 */

import { MongoClient, type Db, type ObjectId } from 'mongodb';
import { createHash } from 'node:crypto';

const MONGO_URI = process.env.MONGODB_URL ?? process.env.MONGO_URI ?? 'mongodb://localhost:27017';
const DB_NAME   = process.env.MONGODB_DB  ?? process.env.MONGO_DB  ?? 'trader';

const OHLCV_BARS = 'ohlcv_bars';

// Mirror of packages/shared-bars/src/content-hash.ts. Kept inline so this migration
// is a single self-contained file — no monorepo build required to run it. Any
// divergence here would cause the live writer and the migration to disagree about
// what counts as "the same content" — be careful.
const fix = (n: number | undefined | null): string =>
  n == null || !Number.isFinite(n as number) ? '∅' : (n as number).toFixed(8);

interface BarDoc {
  _id: ObjectId;
  ticker?: string;
  open?: number; high?: number; low?: number; close?: number; volume?: number;
  rawClose?: number; adjustedClose?: number; adjustmentFactor?: number;
  timestamp?: number | Date;
  observation_ts?: number;
  knowledge_ts?: number;
  is_superseded?: boolean;
  content_hash?: string;
  interval?: string;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function hashBarContent(doc: BarDoc): string {
  const canonical = [
    fix(num(doc.open as unknown)),
    fix(num(doc.high as unknown)),
    fix(num(doc.low as unknown)),
    fix(num(doc.close as unknown)),
    String(Math.round(num(doc.volume as unknown) ?? 0)),
    fix(num(doc.rawClose as unknown)),
    fix(num(doc.adjustedClose as unknown)),
    fix(num(doc.adjustmentFactor as unknown)),
  ].join('|');
  return createHash('sha1').update(canonical).digest('hex');
}

function toObservationMs(doc: BarDoc): number {
  if (typeof doc.observation_ts === 'number') return doc.observation_ts;
  const ts = doc.timestamp;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  throw new Error(`document ${doc._id} has neither observation_ts nor timestamp`);
}

async function assertReplicaSet(client: MongoClient): Promise<void> {
  // db.adminCommand('hello') reports `setName` only when the deployment is a replica
  // set. Multi-document transactions (used by the new writer) require this.
  const hello = await client.db('admin').command({ hello: 1 });
  if (!hello.setName) {
    console.error('[migration] FATAL: MongoDB is not configured as a replica set.');
    console.error('  The new bi-temporal writer relies on multi-document transactions which need rs0+.');
    console.error('  Bitnami: set `architecture: replicaset` in the Helm release and reapply.');
    process.exit(1);
  }
  console.log(`[migration] replica set OK (setName=${hello.setName})`);
}

async function backfillExistingRows(db: Db): Promise<{ scanned: number; updated: number; skipped: number }> {
  const coll = db.collection<BarDoc>(OHLCV_BARS);

  // Only touch rows that don't yet have observation_ts. Once migrated, this match
  // is empty and rerunning costs one indexed find.
  const cursor = coll.find({ observation_ts: { $exists: false } });
  const now = Date.now();
  let scanned = 0, updated = 0, skipped = 0;

  // Stream in batches to keep memory bounded on populated collections.
  while (await cursor.hasNext()) {
    const batch: BarDoc[] = [];
    while (await cursor.hasNext() && batch.length < 500) {
      const doc = await cursor.next();
      if (doc) batch.push(doc);
    }
    if (batch.length === 0) break;
    scanned += batch.length;

    const ops = batch.map((doc) => {
      let obsMs: number;
      try { obsMs = toObservationMs(doc); }
      catch (err) { skipped++; console.warn(`[migration] skip _id=${String(doc._id)}: ${(err as Error).message}`); return null; }

      // Treat the existing row as the *single observed revision known at observation
      // time + 5 minutes after polling*. The 5-minute offset matches the old default
      // poll cadence — it's a best-guess for when the row was actually written.
      // Backtest queries with asOf < observation_ts won't see these rows (correct —
      // we have no record of what we knew then), but live reads (asOf undefined) see
      // them all (correct).
      const knowledgeMs = obsMs + 5 * 60 * 1000;
      return {
        updateOne: {
          filter: { _id: doc._id },
          update: {
            $set: {
              observation_ts: obsMs,
              knowledge_ts:   knowledgeMs,
              content_hash:   hashBarContent(doc),
              is_superseded:  false,
            },
          },
        },
      };
    }).filter((op): op is NonNullable<typeof op> => op !== null);

    if (ops.length > 0) {
      const result = await coll.bulkWrite(ops, { ordered: false });
      updated += (result.modifiedCount ?? 0) + (result.upsertedCount ?? 0);
    }
    process.stdout.write(`\r[migration] backfill: scanned=${scanned} updated=${updated} skipped=${skipped}`);
  }
  process.stdout.write('\n');

  return { scanned, updated, skipped };
}

async function ensureIndexes(db: Db): Promise<void> {
  const coll = db.collection(OHLCV_BARS);

  // Create the new indexes first. Doing this before dropping the legacy index
  // means uniqueness on (ticker, observation_ts, interval, knowledge_ts) is
  // continuously enforced — a concurrent writer mid-migration can't insert a
  // duplicate at any moment.
  console.log('[migration] creating bar_btemporal_unique …');
  await coll.createIndex(
    { ticker: 1, observation_ts: 1, interval: 1, knowledge_ts: 1 },
    { unique: true, name: 'bar_btemporal_unique' },
  );
  console.log('[migration] creating bar_latest_unique (partial is_superseded:false) …');
  await coll.createIndex(
    { ticker: 1, observation_ts: 1, interval: 1 },
    { unique: true, partialFilterExpression: { is_superseded: false }, name: 'bar_latest_unique' },
  );
  console.log('[migration] creating bar_knowledge_lookup …');
  await coll.createIndex(
    { ticker: 1, knowledge_ts: 1 },
    { name: 'bar_knowledge_lookup' },
  );

  // Now drop the legacy unique index. New writes don't carry a `timestamp` field
  // (post-deploy), so this index would collide every insert on the null tuple.
  try {
    await coll.dropIndex('ticker_timestamp_interval_unique');
    console.log('[migration] dropped legacy ticker_timestamp_interval_unique');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/index not found|ns not found/i.test(msg)) {
      console.log('[migration] legacy ticker_timestamp_interval_unique already absent (fresh deploy or prior run)');
    } else {
      console.warn('[migration] legacy index drop failed (non-fatal):', msg);
    }
  }
}

async function reportFinalState(db: Db): Promise<void> {
  const coll = db.collection(OHLCV_BARS);
  const [total, withObs, withoutObs, indexes] = await Promise.all([
    coll.estimatedDocumentCount(),
    coll.countDocuments({ observation_ts: { $exists: true } }),
    coll.countDocuments({ observation_ts: { $exists: false } }),
    coll.indexes(),
  ]);
  console.log('[migration] final state:');
  console.log(`  total rows:                ${total}`);
  console.log(`  with observation_ts:       ${withObs}`);
  console.log(`  without observation_ts:    ${withoutObs}`);
  console.log(`  indexes:                   ${indexes.map((i) => i.name).join(', ')}`);
  if (withoutObs > 0) {
    console.warn('[migration] WARNING: some rows still missing observation_ts — re-run after fixing.');
    process.exit(2);
  }
}

async function main(): Promise<void> {
  console.log(`[migration] connecting to ${MONGO_URI} db=${DB_NAME}`);
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    await assertReplicaSet(client);
    const db = client.db(DB_NAME);

    const stats = await backfillExistingRows(db);
    console.log(`[migration] backfill done: scanned=${stats.scanned} updated=${stats.updated} skipped=${stats.skipped}`);

    await ensureIndexes(db);
    await reportFinalState(db);
    console.log('[migration] ✅ complete');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('[migration] FATAL', err);
  process.exit(1);
});
