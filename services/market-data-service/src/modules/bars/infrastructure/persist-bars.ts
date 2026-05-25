// Bi-temporal write path for ohlcv_bars. Used by both the live-poll loop and
// the admin/bootstrap backfill — anything that persists bars goes through here.
//
// Contract:
//   • Cosmetic re-polls (incoming hash == latest stored hash) are no-ops.
//   • Genuine revisions atomically supersede the prior row and insert the new
//     one, plus a `bar_revisions_log` audit entry, in one transaction. A crash
//     mid-write leaves no orphan.
//   • First-prints insert a single row with `is_superseded: false` and a
//     `bar_revisions_log` entry whose `prior_hash` is null.
//   • Caller-supplied bars must set `observation_ts`. The writer stamps
//     `knowledge_ts` and `content_hash` at write time.
//
// See agent-docs/plans/point-in-time-bar-history.md §Ingest.

import type { ClientSession, Db } from 'mongodb';
import { COLLECTIONS, getMongoClient } from '@trader/shared-mongo';
import { hashBarContent } from '@trader/shared-bars';
import type { BarInterval, OHLCVBar } from '@trader/shared-types';
import { log } from '../../../logger.ts';
import { writeBarRevisionsPg } from './pg-bar-writer.ts';

export interface WriteBarRevisionsStats {
  attempted: number;   // bars handed in
  inserted:  number;   // new revisions written (first-prints + revisions)
  revisions: number;   // subset of `inserted` that superseded a prior row
  skipped:   number;   // cosmetic re-polls — identical hash to the latest
}

/**
 * Batch-fetch the *first-print* close per (ticker, observation_ts) for the incoming
 * bars. "First-print" = the row with the smallest `knowledge_ts` at that observation.
 * Used by the validator to distinguish revisions (key present) from first-prints (key
 * absent), and to compute revision drift for the `revision_zscore_anomaly` audit.
 *
 * Returns an empty map when input is empty. Tickers/observation_ts pairs with no prior
 * row are simply absent from the map — callers must treat that as "first-print".
 */
export async function fetchFirstPrintCloses(
  db: Db,
  bars: OHLCVBar[],
  interval: BarInterval,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (bars.length === 0) return out;
  const coll = db.collection(COLLECTIONS.OHLCV_BARS);
  const keys = bars.map((b) => ({ ticker: b.ticker, observation_ts: b.observation_ts, interval }));

  // Aggregate latest-first-print per key. The $sort+$group({$first}) pattern picks the
  // smallest knowledge_ts for each (ticker, observation_ts) and reads its close.
  const rows = await coll.aggregate([
    { $match: { $or: keys } },
    { $sort: { knowledge_ts: 1 } },
    { $group: {
        _id:   { ticker: '$ticker', observation_ts: '$observation_ts' },
        close: { $first: '$close' },
    } },
  ]).toArray() as Array<{ _id: { ticker: string; observation_ts: number }; close: number }>;

  for (const row of rows) {
    out.set(`${row._id.ticker}|${row._id.observation_ts}`, row.close);
  }
  return out;
}

/**
 * Persist a batch of bars bi-temporally. Idempotent: re-running on the same
 * provider response writes zero rows.
 *
 * Performance shape: one batched `find` for prior revisions, then a per-bar
 * decision. Cosmetic skips never enter a transaction; only genuine revisions
 * (or first-prints) start a session + transaction. In steady state (Yahoo
 * doesn't revise), the cost is one `find` per call, zero writes.
 */
export async function writeBarRevisions(
  db: Db,
  bars: OHLCVBar[],
  interval: BarInterval,
  now: number = Date.now(),
): Promise<WriteBarRevisionsStats> {
  const stats: WriteBarRevisionsStats = { attempted: bars.length, inserted: 0, revisions: 0, skipped: 0 };
  if (bars.length === 0) return stats;

  const coll = db.collection(COLLECTIONS.OHLCV_BARS);
  const auditColl = db.collection(COLLECTIONS.BAR_REVISIONS_LOG);

  // Pre-compute hashes once. Bars carry hashes downstream too in case the validator
  // or audit consumer wants them without re-hashing.
  const incoming = bars
    .filter((b) => Number.isFinite(b.observation_ts))
    .map((bar) => ({ bar, hash: bar.content_hash ?? hashBarContent(bar) }));
  if (incoming.length === 0) return stats;

  // Single fetch of the current latest revision per (ticker, observation_ts).
  // Bounded by the partial-unique index on (ticker, observation_ts, interval) filtered
  // by is_superseded:false — sub-ms at universe scale.
  const keys = incoming.map(({ bar }) => ({
    ticker: bar.ticker,
    observation_ts: bar.observation_ts,
    interval,
  }));
  const latest = await coll.find(
    { $or: keys, is_superseded: false },
    { projection: { _id: 0, ticker: 1, observation_ts: 1, content_hash: 1 } },
  ).toArray();
  const latestByKey = new Map<string, string | undefined>(
    latest.map((d: Record<string, unknown>) =>
      [`${d.ticker}|${d.observation_ts}`, typeof d.content_hash === 'string' ? d.content_hash : undefined]),
  );

  const client = await getMongoClient();
  let session: ClientSession | null = null;

  try {
    for (const { bar, hash } of incoming) {
      const key = `${bar.ticker}|${bar.observation_ts}`;
      const priorHash = latestByKey.get(key);
      if (priorHash === hash) {
        stats.skipped++;
        continue;
      }

      const isRevision = priorHash !== undefined;
      // Lazy session — only opened on the first bar that actually needs a write.
      // Steady-state cycles (all cosmetic skips) never open a session.
      if (session === null) session = client.startSession();

      // Stamp the next-revision row. knowledge_ts is `now` for live writes; for
      // backfill of historical bars we still use `now` because that's when we
      // *learned* about the bar — knowledge_ts is wall-clock, not bar time.
      const doc: Record<string, unknown> = {
        ticker:         bar.ticker,
        observation_ts: bar.observation_ts,
        knowledge_ts:   now,
        interval,
        open:   bar.open,
        high:   bar.high,
        low:    bar.low,
        close:  bar.close,
        volume: bar.volume,
        content_hash:   hash,
        is_superseded:  false,
      };
      // Conditionally include optional columns to avoid polluting docs with explicit
      // undefined values (Mongo serialises those as null which breaks downstream
      // existence checks).
      if (bar.currency)         doc.currency         = bar.currency;
      if (bar.rawClose != null) doc.rawClose         = bar.rawClose;
      else                      doc.rawClose         = bar.close;
      if (bar.adjustedClose    != null) doc.adjustedClose    = bar.adjustedClose;
      if (bar.adjustmentFactor != null) doc.adjustmentFactor = bar.adjustmentFactor;

      try {
        await session.withTransaction(async () => {
          if (isRevision) {
            await coll.updateMany(
              { ticker: bar.ticker, observation_ts: bar.observation_ts, interval, is_superseded: false },
              { $set: { is_superseded: true } },
              { session: session! },
            );
          }
          await coll.insertOne(doc, { session: session! });
          await auditColl.insertOne({
            ticker:         bar.ticker,
            observation_ts: bar.observation_ts,
            interval,
            knowledge_ts:   now,
            prior_hash:     priorHash ?? null,
            new_hash:       hash,
            loggedAt:       new Date(),
          }, { session: session! });
        });
        stats.inserted++;
        if (isRevision) stats.revisions++;
        // Update the in-memory map so a duplicate hash within the same batch is treated
        // as a no-op even before the next persistBars cycle re-fetches latest revisions.
        latestByKey.set(key, hash);
      } catch (err) {
        // Per-bar isolation: a single failed revision doesn't abort the whole batch.
        // The next poll cycle's re-fetch will retry. Log loud — silent failures here
        // are exactly the silent-overwrite class of bug this plan is trying to remove.
        log.error(`[persist-bars] revision failed for ${bar.ticker}@${bar.observation_ts}:`, err);
      }
    }
  } finally {
    if (session !== null) await session.endSession();
  }

  // Dual-write to Timescale during the migration window. Strictly best-effort —
  // a PG failure here MUST NOT fail the Mongo write that already succeeded. The
  // equivalence verification job (bar-equivalence.test.ts) catches divergence;
  // the operator re-runs the targeted backfill on the affected tickers.
  //
  // The gate is read fresh each call so toggling the env without a restart works
  // (e.g. operator flipping it off mid-cutover to investigate a problem).
  if (process.env.DUAL_WRITE_BARS === 'true') {
    try {
      await writeBarRevisionsPg(bars, interval, now);
    } catch (err) {
      log.error(`[persist-bars] timescale dual-write failed (Mongo write still succeeded):`, err);
      try {
        const dualFailuresColl = db.collection('dual_write_failures');
        const obsTsValues = bars.map((b) => b.observation_ts).filter((t) => Number.isFinite(t));
        await dualFailuresColl.insertOne({
          tickers:              [...new Set(bars.map((b) => b.ticker))],
          observation_ts_range: obsTsValues.length > 0
            ? [Math.min(...obsTsValues), Math.max(...obsTsValues)]
            : null,
          interval,
          error:                err instanceof Error ? err.message : String(err),
          loggedAt:             new Date(),
        });
      } catch (logErr) {
        // If even the failure-log write fails (Mongo down? collection denied?),
        // we still need to keep going — the Mongo bars write already landed.
        log.error('[persist-bars] failed to log dual-write failure (continuing):', logErr);
      }
    }
  }

  return stats;
}

// Index-management helper — owned here so both the live-poll bootstrap and any
// admin-driven rebuild paths converge on the same set. Idempotent: dropping the
// old index is wrapped in try/catch; creating the new ones is a no-op if they
// already match.
//
// New layout:
//   - { ticker, observation_ts, interval, knowledge_ts } unique  → covers compound
//     uniqueness and the as-of aggregation match.
//   - { ticker, observation_ts, interval } partial-unique is_superseded:false →
//     live-read fast lane; exactly one row per logical bar.
//   - { ticker, knowledge_ts }                                   → revisions admin
//     endpoint lookups.
//
// Old `ticker_timestamp_interval_unique` is dropped here because new writes don't
// set `timestamp` — leaving the old unique index in place would silently collide
// every insert on (null, null, null).
export async function ensureBiTemporalIndexes(db: Db): Promise<void> {
  const coll = db.collection(COLLECTIONS.OHLCV_BARS);

  try {
    // Sanity: a time-series collection rejects unique indexes outright (and is the
    // failure mode you only discover at 3am the first time the Bitnami chart upgrades).
    const info = await db.listCollections({ name: COLLECTIONS.OHLCV_BARS }).toArray();
    const collMeta = info[0];
    if (collMeta && (collMeta.type === 'timeseries' || (collMeta as { options?: { timeseries?: unknown } }).options?.timeseries)) {
      log.error('[market-data] FATAL: ohlcv_bars is a time-series collection — unique indexes are unsupported. Run: db.ohlcv_bars.drop(); db.createCollection("ohlcv_bars"); then redeploy.');
      throw new Error('ohlcv_bars is a time-series collection');
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('time-series')) throw err;
    log.warn('[market-data] could not check collection type:', err);
  }

  // Best-effort drop the legacy unique index. New writes don't include a `timestamp`
  // field; if this index survives, every insert collides on the null tuple.
  try {
    await coll.dropIndex('ticker_timestamp_interval_unique');
    log.info('[market-data] dropped legacy index ticker_timestamp_interval_unique');
  } catch (err) {
    // Expected on fresh deploys (index never existed) — log at debug only.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/index not found|ns not found/i.test(msg)) {
      log.warn('[market-data] legacy index drop failed (likely already absent):', msg);
    }
  }

  await coll.createIndex(
    { ticker: 1, observation_ts: 1, interval: 1, knowledge_ts: 1 },
    { unique: true, name: 'bar_btemporal_unique' },
  ).catch((err) => log.warn('[market-data] bar_btemporal_unique create failed:', err instanceof Error ? err.message : err));

  await coll.createIndex(
    { ticker: 1, observation_ts: 1, interval: 1 },
    {
      unique: true,
      partialFilterExpression: { is_superseded: false },
      name: 'bar_latest_unique',
    },
  ).catch((err) => log.warn('[market-data] bar_latest_unique create failed:', err instanceof Error ? err.message : err));

  await coll.createIndex(
    { ticker: 1, knowledge_ts: 1 },
    { name: 'bar_knowledge_lookup' },
  ).catch((err) => log.warn('[market-data] bar_knowledge_lookup create failed:', err instanceof Error ? err.message : err));
}
