import { createHash } from 'node:crypto';
import { getPgPool } from '@trader/shared-pg';
import type { Finding } from '../application/ReconciliationChecks.ts';

// Append-only writer for the reconciliation ledger (Timescale, 0005). Idempotent on a
// content hash so re-running a cycle (pod restart, manual re-trigger) never duplicates rows.
// Resolutions are NEW rows (supersedes_id) — never in-place edits (audit_writer has no UPDATE).
export interface NavSnapshot {
  cash: number;
  positionsValue: number;
  nav: number;
  currency?: string;
  source?: string;
}

export class ReconciliationStore {
  private hash(cycleId: string, f: Finding): string {
    const key = JSON.stringify([cycleId, f.ticker, f.driftType, f.systemState, f.brokerState]);
    return createHash('sha1').update(key).digest('hex');
  }

  async writeFinding(
    cycleId: string,
    occurredAt: Date,
    effectiveAt: Date,
    f: Finding,
  ): Promise<void> {
    const pool = getPgPool();
    await pool.query(
      `INSERT INTO reconciliation_log
         (occurred_at, effective_at, cycle_id, ticker, drift_type, severity, is_clean,
          system_state, broker_state, audit_state, diff, threshold, resolution, content_hash)
       VALUES ($1,$2,$3,$4,$5::drift_type,$6::drift_severity,$7,$8,$9,$10,$11,$12,
               $13::drift_resolution,$14)
       ON CONFLICT (content_hash, occurred_at) DO NOTHING`,
      [
        occurredAt, effectiveAt, cycleId, f.ticker, f.driftType, f.severity, f.isClean,
        JSON.stringify(f.systemState), JSON.stringify(f.brokerState), JSON.stringify(f.auditState),
        JSON.stringify(f.diff), JSON.stringify(f.threshold),
        f.isClean ? 'auto_healed' : 'open', this.hash(cycleId, f),
      ],
    );
  }

  async markResolution(findingId: number, resolution: string, resolvedBy: string): Promise<void> {
    // New superseding row (append-only) — references the prior finding.
    const pool = getPgPool();
    await pool.query(
      `INSERT INTO reconciliation_log
         (occurred_at, effective_at, cycle_id, severity, is_clean, resolution, resolved_at,
          resolved_by, supersedes_id, content_hash)
       SELECT NOW(), effective_at, cycle_id, 'clean'::drift_severity, TRUE,
              $2::drift_resolution, NOW(), $3, finding_id,
              md5(random()::text || finding_id::text)
       FROM reconciliation_log WHERE finding_id = $1
       ORDER BY occurred_at DESC LIMIT 1`,
      [findingId, resolution, resolvedBy],
    );
  }

  async writeNav(snapshotAt: Date, nav: NavSnapshot): Promise<void> {
    const pool = getPgPool();
    await pool.query(
      `INSERT INTO nav_history (snapshot_at, cash, positions_value, nav, currency, source)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [snapshotAt, nav.cash, nav.positionsValue, nav.nav, nav.currency ?? 'GBP', nav.source ?? 'reconciliation'],
    );
  }

  async readPriorCash(): Promise<number | null> {
    const pool = getPgPool();
    const { rows } = await pool.query<{ cash: number }>(
      `SELECT cash FROM nav_history ORDER BY snapshot_at DESC LIMIT 1`,
    );
    return rows.length ? Number(rows[0]!.cash) : null;
  }

  // ── Reads for the operator portal ───────────────────────────────────────────
  async listFindings(openOnly: boolean, limit: number): Promise<Record<string, unknown>[]> {
    const pool = getPgPool();
    const where = openOnly ? `WHERE resolution = 'open' AND is_clean = FALSE` : `WHERE is_clean = FALSE`;
    const { rows } = await pool.query(
      `SELECT finding_id, occurred_at, effective_at, cycle_id, ticker, drift_type, severity,
              resolution, diff, threshold
       FROM reconciliation_log ${where}
       ORDER BY occurred_at DESC LIMIT $1`,
      [limit],
    );
    return rows as Record<string, unknown>[];
  }

  async listNav(limit: number): Promise<Record<string, unknown>[]> {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT snapshot_at, cash, positions_value, nav, currency, source
       FROM nav_history ORDER BY snapshot_at DESC LIMIT $1`,
      [limit],
    );
    return rows as Record<string, unknown>[];
  }
}
