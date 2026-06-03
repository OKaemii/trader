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

  // Filterable read for the trade-audit view. All filters optional + parameterised.
  async listFills(f: FillFilter): Promise<FillRow[]> {
    const { sql, params } = buildFillsQuery(f);
    const { rows } = await getPgPool().query(sql, params);
    return rows.map((r: Record<string, unknown>) => ({
      filledAt:  Number(r.filled_at_ms),
      ticker:    String(r.ticker),
      side:      String(r.side),
      quantity:  Number(r.quantity),
      fillPrice: Number(r.fill_price),
      currency:  String(r.currency),
      orderId:   String(r.order_id),
      signalId:  r.signal_id == null ? null : String(r.signal_id),
      source:    String(r.source),
    }));
  }
}

export interface FillFilter {
  ticker?: string | undefined;
  side?: 'BUY' | 'SELL' | undefined;
  sinceMs?: number | undefined;
  limit?: number | undefined;
}

export interface FillRow {
  filledAt: number;
  ticker: string;
  side: string;
  quantity: number;
  fillPrice: number;
  currency: string;
  orderId: string;
  signalId: string | null;
  source: string;
}

// Pure filter→SQL mapping for fills_history (parameterised WHERE, DESC, clamped LIMIT). Pulled out
// of the store so the mapping is unit-testable without a live Postgres.
export function buildFillsQuery(f: FillFilter): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.ticker)         { params.push(f.ticker.toUpperCase()); where.push(`ticker = $${params.length}`); }
  if (f.side)           { params.push(f.side);                 where.push(`side = $${params.length}`); }
  if (f.sinceMs != null) { params.push(f.sinceMs);             where.push(`filled_at >= to_timestamp($${params.length}/1000.0)`); }
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
  params.push(limit);
  const sql =
    `SELECT extract(epoch from filled_at) * 1000 AS filled_at_ms, ticker, side, quantity,
            fill_price, currency, order_id, signal_id, source
     FROM fills_history
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY filled_at DESC LIMIT $${params.length}`;
  return { sql, params };
}
