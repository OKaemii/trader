// Bi-temporal write path for the Timescale `bars` hypertable. The Postgres
// twin of persist-bars.ts's writeBarRevisions — same skip gate, same supersede
// flow, same per-bar transaction isolation.
//
// Used in three places once the migration completes:
//   • live-poll loop (when DUAL_WRITE_BARS=true during the cutover window)
//   • admin/bootstrap backfill (same paths as today, dual-writing)
//   • the Mongo→Timescale backfill migration script (task 14) — fast path that
//     skips the audit log because the migration carries its own audit trail.
//
// Contract mirrors persist-bars.ts: cosmetic re-polls (incoming hash == latest
// stored hash) are no-ops; genuine revisions atomically supersede the prior row
// and insert the new one plus a bar_revisions_log entry, in one transaction.
// First-prints insert without superseding and write a log entry whose
// prior_hash is NULL.

import { hashBarContent } from '@trader/shared-bars';
import { getPgPool } from '@trader/shared-pg';
import { Trading212TickerAdapter } from '@trader/ticker-identity';
import type { BarInterval, OHLCVBar } from '@trader/shared-types';
import { log } from '../../../logger.ts';

// Storage is keyed on the bare identity (symbol, market), never the concatenated T212 ticker.
// Bars flow through this writer carrying OHLCVBar.ticker (the T212 form) during the Thread A
// transition; split it here at the write boundary. `fromT212` is the platform's single suffix parser.
const tickerAdapter = new Trading212TickerAdapter();

export interface WriteBarRevisionsStats {
  attempted: number;
  inserted:  number;
  revisions: number;
  skipped:   number;
}

/**
 * Maximum bars per write batch. The write path bounds itself by `observation_ts`
 * for the same reason getBarAtOrBefore bounds its read (epic pit-coverage-completeness
 * §C1, the range='max' read-path twin of this fix): a deep backfill (~7545 daily bars
 * spanning 2006→now) handed to writeBarRevisionsPg as one array makes the batched
 * "latest revision" lookup probe `(ticker, observation_ts)` keys across the ENTIRE
 * 2006→now span. TimescaleDB cannot prune chunks for an IN-list straddling the whole
 * range, so the planner opens an index scan — and takes a lock — on every one of the
 * ~1500+ 7-day chunks at executor startup. That overflows the shared lock table
 * (`max_locks_per_transaction`) → "out of shared memory" / SQLSTATE 53200 /
 * LockAcquireExtended, and the DUAL_WRITE Timescale write fails while the Mongo write
 * still succeeds (so the deep series lands in Mongo but not the timescale read store).
 *
 * The fix is two parts working together (sorting + batching alone is NOT enough — see
 * writeBatchPg): bars are sorted by `observation_ts` and split into bounded batches so a
 * batch's observation span is contiguous and narrow (~250 days), and each batch's lookup
 * then carries an explicit LITERAL `observation_ts BETWEEN min AND max` bound that
 * TimescaleDB CAN use for chunk exclusion (the opaque IN-list cannot). Each lookup thus
 * touches only that batch's ~36 7-day chunks, under the lock budget regardless of how deep
 * the full series is. The live poll path (1 bar/ticker/day) is a single tiny batch and is
 * unaffected.
 *
 * Overridable via PG_BAR_WRITE_BATCH_SIZE for an operator that needs to tune it to a
 * different chunk_time_interval / lock budget; 250 is a sane default.
 */
export const WRITE_BATCH_SIZE = (() => {
  const raw = Number(process.env.PG_BAR_WRITE_BATCH_SIZE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 250;
})();

// Anything with a `query` method — the pg Pool OR a checked-out PoolClient. The supersede helper runs
// inside the writer's per-bar transaction, so it takes the same client (not the pool) to stay in-txn.
type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> };

/**
 * Resolve the `_timescaledb_internal._hyper_*_chunk` relation of the `bars` hypertable that holds a
 * given `observation_ts`, or `null` when no chunk covers it (no row at that instant). Used by the
 * supersede step to UPDATE the ONE owning chunk directly instead of the parent hypertable.
 *
 * WHY (the QA-FAILED defect-1 root cause): a plain `UPDATE bars … WHERE observation_ts = X` — with X a
 * bind param OR an inlined literal OR a single-chunk range — locks EVERY chunk of the `bars` hypertable
 * at planner/executor startup on TimescaleDB 2.17: the `ModifyTable` result-relation is the whole
 * hypertable and DML chunk-exclusion does NOT prune it (verified — even `EXPLAIN UPDATE` errors 53200
 * under a tight lock budget). Production has ~30 curated names with deep daily (back to 1991) + 5m
 * chunks, so the hypertable's total chunk count overflows the shared lock table → "out of shared memory"
 * / SQLSTATE 53200, and EVERY per-bar supersede (a re-emit of a UTC day is a revision for each name)
 * fails + rolls back — the write silently does not land. Targeting the single owning chunk's underlying
 * table updates exactly one relation, so the lock footprint is one chunk regardless of series depth.
 *
 * The chunk is resolved from `_timescaledb_catalog` (stable across the 2.x line): the dimension slice on
 * the `observation_ts` dimension whose `[range_start, range_end)` brackets the value. `dropped = false`
 * skips tombstoned chunks. A revision always has a prior live row, so its chunk exists; `null` is the
 * defensive path (the caller then skips the supersede — a first-print never calls this).
 */
async function resolveBarsChunkFor(q: Queryable, observationTs: number): Promise<string | null> {
  const { rows } = await q.query(
    `SELECT format('%I.%I', c.schema_name, c.table_name) AS chunk
       FROM _timescaledb_catalog.chunk c
       JOIN _timescaledb_catalog.hypertable h       ON c.hypertable_id = h.id
       JOIN _timescaledb_catalog.chunk_constraint cc ON cc.chunk_id = c.id
       JOIN _timescaledb_catalog.dimension_slice ds  ON ds.id = cc.dimension_slice_id
       JOIN _timescaledb_catalog.dimension d         ON d.id = ds.dimension_id AND d.hypertable_id = h.id
      WHERE h.table_name = 'bars'
        AND d.column_name = 'observation_ts'
        AND $1 >= ds.range_start
        AND $1 <  ds.range_end
        AND c.dropped = false
      LIMIT 1`,
    [observationTs],
  );
  const chunk = rows[0]?.chunk;
  return typeof chunk === 'string' ? chunk : null;
}

/**
 * Batch-fetch the *first-print* close per (ticker, observation_ts) for the incoming
 * bars. "First-print" = the row with the smallest `knowledge_ts` at that observation.
 *
 * Used by the validator to distinguish revisions (key present) from first-prints
 * (key absent), and to compute revision drift for the `revision_zscore_anomaly`
 * audit. Parallels fetchFirstPrintCloses in persist-bars.ts.
 */
export async function fetchFirstPrintClosesPg(
  bars: OHLCVBar[],
  interval: BarInterval,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (bars.length === 0) return out;
  const pool = getPgPool();

  // Build a (symbol, market, observation_ts) tuple list for the lookup. We use unnest + array params
  // so a 200-key batch goes over the wire as three arrays, not 600 individual binds. Keys are
  // identity-shaped (`symbol|market|observation_ts`) so the caller matches against the same split.
  const ids       = bars.map((b) => tickerAdapter.fromT212(b.ticker));
  const symbols   = ids.map((id) => id.symbol);
  const markets   = ids.map((id) => id.market);
  const obsTsList = bars.map((b) => b.observation_ts);

  const { rows } = await pool.query<{ symbol: string; market: string; observation_ts: string; close: string }>(
    `SELECT DISTINCT ON (symbol, market, observation_ts)
       symbol, market, observation_ts, close
     FROM bars
     WHERE interval = $1
       AND (symbol, market, observation_ts) IN (
         SELECT unnest($2::text[]), unnest($3::text[]), unnest($4::bigint[])
       )
     ORDER BY symbol, market, observation_ts, knowledge_ts ASC`,
    [interval, symbols, markets, obsTsList],
  );

  for (const row of rows) {
    out.set(`${row.symbol}|${row.market}|${row.observation_ts}`, Number(row.close));
  }
  return out;
}

/**
 * Persist a batch of bars bi-temporally into Timescale. Idempotent on repeat
 * application: re-running on the same provider response writes zero rows.
 *
 * Performance shape: bars are sorted by `observation_ts` and committed in bounded
 * WRITE_BATCH_SIZE batches. Each batch runs its own scoped "latest revision" lookup
 * (over a contiguous, narrow `observation_ts` span) and per-bar transactions, so no
 * single statement touches more chunks than its ~250-day window holds — see
 * WRITE_BATCH_SIZE for why this bound is load-bearing. Cosmetic skips never check out
 * a pool client; only genuine revisions (or first-prints) open a transaction.
 */
export async function writeBarRevisionsPg(
  bars: OHLCVBar[],
  interval: BarInterval,
  now: number = Date.now(),
): Promise<WriteBarRevisionsStats> {
  const stats: WriteBarRevisionsStats = {
    attempted: bars.length,
    inserted:  0,
    revisions: 0,
    skipped:   0,
  };
  if (bars.length === 0) return stats;

  // Pre-compute hashes once. The writer accepts producer-side bars without
  // content_hash set; we hash them here. Bars that already carry a hash are
  // trusted (the validator has already canonicalised them).
  // Sort by observation_ts so each bounded batch's lookup IN-list is contiguous in
  // time — the property that keeps chunk-locking under the budget (see WRITE_BATCH_SIZE).
  const incoming = bars
    .filter((b) => Number.isFinite(b.observation_ts))
    .map((bar) => ({ bar, hash: bar.content_hash ?? hashBarContent(bar) }))
    .sort((a, b) => a.bar.observation_ts - b.bar.observation_ts);
  if (incoming.length === 0) return stats;

  for (let i = 0; i < incoming.length; i += WRITE_BATCH_SIZE) {
    const batch = incoming.slice(i, i + WRITE_BATCH_SIZE);
    await writeBatchPg(batch, interval, now, stats);
  }

  return stats;
}

/**
 * Persist one bounded batch of (already-sorted, already-hashed) bars. Mutates `stats`.
 * Each call's "latest revision" lookup probes only this batch's narrow, contiguous
 * `observation_ts` span, and each bar's supersede+insert+audit stays atomic in its own
 * transaction (the bi-temporal invariant is per-bar, so it holds within any batch).
 */
async function writeBatchPg(
  batch: Array<{ bar: OHLCVBar; hash: string }>,
  interval: BarInterval,
  now: number,
  stats: WriteBarRevisionsStats,
): Promise<void> {
  if (batch.length === 0) return;
  const pool = getPgPool();

  // Storage is keyed on (symbol, market); split each bar's T212 ticker once up-front so the lookup,
  // the supersede UPDATE, and both INSERTs all use the same identity. (Carried alongside the bar so
  // we never re-parse.)
  const items = batch.map(({ bar, hash }) => ({ bar, hash, id: tickerAdapter.fromT212(bar.ticker) }));

  // Single fetch of the current latest revision per (symbol, market, observation_ts) — scoped
  // to this batch only. The batch is sorted by observation_ts, so an explicit
  // `observation_ts BETWEEN min AND max` range narrows the read to that span. The bounds
  // are inlined as integer LITERALS (not bind params) and this is load-bearing: the
  // `(symbol, market, observation_ts) IN (SELECT unnest(...))` list is OPAQUE to the planner (it
  // can't read the array's value range at plan time), so without an explicit time bound
  // the read opens — and locks — every chunk of a deep hypertable before resolving the
  // membership test → "out of shared memory" / SQLSTATE 53200. A *parameterized* range
  // doesn't reliably help either: node-postgres flips to a generic plan after a few
  // executions, and a generic plan can't prune chunks from a bind param. Literal bounds
  // force plan-time constraint exclusion to the batch's ~250-day slice (~36 7-day chunks)
  // on every execution; the IN-list then selects the exact keys within it. `minObsTs`/
  // `maxObsTs` are finite-checked JS numbers (filtered upstream) coerced to decimal, so
  // the inline is injection-safe (never user input — our own bar timestamps). Bounded by
  // the partial-unique index bars_latest_unique.
  const symbols   = items.map(({ id }) => id.symbol);
  const markets   = items.map(({ id }) => id.market);
  const obsTsList = items.map(({ bar }) => bar.observation_ts);
  // Sorted ascending ⇒ first is min, last is max (a guarded read for noUncheckedIndexedAccess).
  const minLiteral = BigInt(Math.trunc(obsTsList[0]!)).toString();
  const maxLiteral = BigInt(Math.trunc(obsTsList[obsTsList.length - 1]!)).toString();

  const { rows: latest } = await pool.query<{
    symbol: string; market: string; observation_ts: string; content_hash: string;
  }>(
    `SELECT symbol, market, observation_ts, content_hash
     FROM bars
     WHERE interval = $1
       AND is_superseded = FALSE
       AND observation_ts >= ${minLiteral}
       AND observation_ts <= ${maxLiteral}
       AND (symbol, market, observation_ts) IN (
         SELECT unnest($2::text[]), unnest($3::text[]), unnest($4::bigint[])
       )`,
    [interval, symbols, markets, obsTsList],
  );
  const latestByKey = new Map<string, string>(
    latest.map((row) => [`${row.symbol}|${row.market}|${row.observation_ts}`, row.content_hash]),
  );

  for (const { bar, hash, id } of items) {
    const key = `${id.symbol}|${id.market}|${bar.observation_ts}`;
    const priorHash = latestByKey.get(key);
    if (priorHash === hash) {
      stats.skipped++;
      continue;
    }
    const isRevision = priorHash !== undefined;

    // Optional column defaults: match the Mongo writer's behaviour (raw_close
    // defaults to close when the provider didn't separately report adjusted).
    const rawClose = bar.rawClose ?? bar.close;
    const adjustedClose    = bar.adjustedClose ?? null;
    const adjustmentFactor = bar.adjustmentFactor ?? null;
    const currency         = bar.currency ?? null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (isRevision) {
        // Flip the prior latest row by updating the ONE owning chunk directly — NOT the parent
        // hypertable. A plain `UPDATE bars … WHERE observation_ts = …` locks every chunk of the deep
        // `bars` hypertable on TimescaleDB 2.17 (DML chunk-exclusion does not prune the ModifyTable
        // result relation — bind param, inlined literal, and single-chunk range were all verified to
        // OOM under a constrained lock budget), so on production's ~30-name deep series it overflowed
        // the shared lock table → SQLSTATE 53200 and EVERY supersede rolled back (the write silently
        // did not land — the QA-FAILED defect 1). `resolveBarsChunkFor` returns the `_hyper_*_chunk`
        // relation bracketing this bar's observation_ts; UPDATEing that relation touches exactly one
        // chunk. The partial-unique index guarantees a single live row to flip; the revision's prior
        // live row exists, so the chunk exists (a `null` chunk — impossible for a real revision — skips
        // the supersede defensively rather than falling back to the hypertable-wide UPDATE that OOMs).
        const chunk = await resolveBarsChunkFor(client, bar.observation_ts);
        if (chunk) {
          await client.query(
            // `chunk` is a TimescaleDB-generated, `format('%I.%I')`-quoted internal relation name (never
            // user input) — safe to interpolate; the row-selecting values stay bind params.
            `UPDATE ${chunk}
                SET is_superseded = TRUE
              WHERE symbol = $1
                AND market = $2
                AND observation_ts = $3
                AND interval = $4
                AND is_superseded = FALSE`,
            [id.symbol, id.market, bar.observation_ts, interval],
          );
        }
      }

      await client.query(
        `INSERT INTO bars
           (symbol, market, observation_ts, knowledge_ts, interval,
            open, high, low, close, volume,
            raw_close, adjusted_close, adjustment_factor, currency,
            content_hash, is_superseded)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,FALSE)`,
        [
          id.symbol, id.market, bar.observation_ts, now, interval,
          bar.open, bar.high, bar.low, bar.close, bar.volume,
          rawClose, adjustedClose, adjustmentFactor, currency,
          hash,
        ],
      );

      await client.query(
        `INSERT INTO bar_revisions_log
           (symbol, market, observation_ts, interval, knowledge_ts, prior_hash, new_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id.symbol, id.market, bar.observation_ts, interval, now, priorHash ?? null, hash],
      );

      await client.query('COMMIT');
      stats.inserted++;
      if (isRevision) stats.revisions++;
      // Update the in-memory map so duplicate hashes within the same batch are
      // treated as no-ops without re-fetching from PG.
      latestByKey.set(key, hash);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* swallow */ }
      // Per-bar isolation: a single failed revision doesn't abort the whole batch.
      // The next poll cycle's re-fetch will retry. Log loud — silent failures here
      // are exactly the silent-overwrite class of bug the bi-temporal plan removes.
      log.error(`[pg-bar-writer] revision failed for ${bar.ticker}@${bar.observation_ts}:`, err);
    } finally {
      client.release();
    }
  }
}
