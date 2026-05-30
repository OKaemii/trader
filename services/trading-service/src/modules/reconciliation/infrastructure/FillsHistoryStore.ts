import { getPgPool } from '@trader/shared-pg';
import type { FillLedgerWriter, FillLedgerRow } from '../../fills/application/FillsPoller.ts';

// Append-only fills ledger (Timescale fills_history, 0005). Idempotent on (fill_id, filled_at)
// so a re-observed fill never double-writes. Also serves the reconciliation engine's
// `ledgerFillIds` window read.
export class FillsHistoryStore implements FillLedgerWriter {
  async recordFill(row: FillLedgerRow): Promise<void> {
    const pool = getPgPool();
    await pool.query(
      `INSERT INTO fills_history
         (filled_at, arrival_at, fill_id, order_id, signal_id, ticker, side, quantity,
          fill_price, currency, source)
       VALUES (to_timestamp($1/1000.0), $2, $3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (fill_id, filled_at) DO NOTHING`,
      [
        row.filledAt,
        row.arrivalAt != null ? new Date(row.arrivalAt) : null,
        row.fillId, row.orderId, row.signalId, row.ticker, row.side, row.quantity,
        row.fillPrice, row.currency, row.source ?? 'fills_poller',
      ],
    );
  }

  async readFillIds(startMs: number, endMs: number): Promise<string[]> {
    const pool = getPgPool();
    const { rows } = await pool.query<{ fill_id: string }>(
      `SELECT fill_id FROM fills_history
       WHERE filled_at >= to_timestamp($1/1000.0) AND filled_at <= to_timestamp($2/1000.0)`,
      [startMs, endMs],
    );
    return rows.map((r) => r.fill_id);
  }
}
