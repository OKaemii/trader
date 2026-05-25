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
import type { BarInterval, OHLCVBar } from '@trader/shared-types';
import { log } from '../../../logger.ts';

export interface WriteBarRevisionsStats {
  attempted: number;
  inserted:  number;
  revisions: number;
  skipped:   number;
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

  // Build a (ticker, observation_ts) tuple list for the lookup. We use
  // unnest + array params so a 200-key batch goes over the wire as two arrays,
  // not 400 individual binds.
  const tickers   = bars.map((b) => b.ticker);
  const obsTsList = bars.map((b) => b.observation_ts);

  const { rows } = await pool.query<{ ticker: string; observation_ts: string; close: string }>(
    `SELECT DISTINCT ON (ticker, observation_ts)
       ticker, observation_ts, close
     FROM bars
     WHERE interval = $1
       AND (ticker, observation_ts) IN (
         SELECT unnest($2::text[]), unnest($3::bigint[])
       )
     ORDER BY ticker, observation_ts, knowledge_ts ASC`,
    [interval, tickers, obsTsList],
  );

  for (const row of rows) {
    out.set(`${row.ticker}|${row.observation_ts}`, Number(row.close));
  }
  return out;
}

/**
 * Persist a batch of bars bi-temporally into Timescale. Idempotent on repeat
 * application: re-running on the same provider response writes zero rows.
 *
 * Performance shape: one batched SELECT for prior-revision hashes, then a per-bar
 * decision. Cosmetic skips never check out a pool client; only genuine revisions
 * (or first-prints) open a transaction.
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

  const pool = getPgPool();

  // Pre-compute hashes once. The writer accepts producer-side bars without
  // content_hash set; we hash them here. Bars that already carry a hash are
  // trusted (the validator has already canonicalised them).
  const incoming = bars
    .filter((b) => Number.isFinite(b.observation_ts))
    .map((bar) => ({ bar, hash: bar.content_hash ?? hashBarContent(bar) }));
  if (incoming.length === 0) return stats;

  // Single fetch of the current latest revision per (ticker, observation_ts).
  // Bounded by the partial-unique index bars_latest_unique — sub-ms at universe scale.
  const tickers   = incoming.map(({ bar }) => bar.ticker);
  const obsTsList = incoming.map(({ bar }) => bar.observation_ts);

  const { rows: latest } = await pool.query<{
    ticker: string; observation_ts: string; content_hash: string;
  }>(
    `SELECT ticker, observation_ts, content_hash
     FROM bars
     WHERE interval = $1
       AND is_superseded = FALSE
       AND (ticker, observation_ts) IN (
         SELECT unnest($2::text[]), unnest($3::bigint[])
       )`,
    [interval, tickers, obsTsList],
  );
  const latestByKey = new Map<string, string>(
    latest.map((row) => [`${row.ticker}|${row.observation_ts}`, row.content_hash]),
  );

  for (const { bar, hash } of incoming) {
    const key = `${bar.ticker}|${bar.observation_ts}`;
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
        // Flip the prior latest row. The partial-unique index guarantees there's
        // exactly one such row to flip.
        await client.query(
          `UPDATE bars
              SET is_superseded = TRUE
            WHERE ticker = $1
              AND observation_ts = $2
              AND interval = $3
              AND is_superseded = FALSE`,
          [bar.ticker, bar.observation_ts, interval],
        );
      }

      await client.query(
        `INSERT INTO bars
           (ticker, observation_ts, knowledge_ts, interval,
            open, high, low, close, volume,
            raw_close, adjusted_close, adjustment_factor, currency,
            content_hash, is_superseded)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,FALSE)`,
        [
          bar.ticker, bar.observation_ts, now, interval,
          bar.open, bar.high, bar.low, bar.close, bar.volume,
          rawClose, adjustedClose, adjustmentFactor, currency,
          hash,
        ],
      );

      await client.query(
        `INSERT INTO bar_revisions_log
           (ticker, observation_ts, interval, knowledge_ts, prior_hash, new_hash)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [bar.ticker, bar.observation_ts, interval, now, priorHash ?? null, hash],
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

  return stats;
}
