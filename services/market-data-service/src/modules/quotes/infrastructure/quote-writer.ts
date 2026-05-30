import { createHash } from 'node:crypto';
import { getPgPool } from '@trader/shared-pg';

// Bi-temporal quote row (matches 0006_quotes.sql). One row per (ticker, observation_ts);
// supersede-then-insert on revision, content-hash no-op on identical re-poll — same discipline
// as the bar writer.
export interface QuoteRow {
  ticker: string;
  observation_ts: number;
  knowledge_ts: number;
  bid: number | null;
  ask: number | null;
  mid: number;
  spread: number | null;
  spread_bps: number | null;
  bid_size: number | null;
  ask_size: number | null;
  market_state: string;
  source: 'yahoo' | 'synthetic' | 'paid_feed_v1';
  is_synthetic: boolean;
}

function contentHash(r: QuoteRow): string {
  return createHash('sha1')
    .update(JSON.stringify([r.bid, r.ask, r.mid, r.spread, r.source]))
    .digest('hex');
}

export class QuoteWriter {
  async writeBatch(rows: QuoteRow[]): Promise<number> {
    let written = 0;
    for (const row of rows) {
      if (await this.writeOne(row)) written += 1;
    }
    return written;
  }

  private async writeOne(row: QuoteRow): Promise<boolean> {
    const pool = getPgPool();
    const hash = contentHash(row);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: existing } = await client.query<{ content_hash: string }>(
        `SELECT content_hash FROM quotes
         WHERE ticker=$1 AND observation_ts=$2 AND is_superseded=FALSE LIMIT 1`,
        [row.ticker, row.observation_ts],
      );
      if (existing.length && existing[0]!.content_hash === hash) {
        await client.query('ROLLBACK');   // identical re-poll → no-op
        return false;
      }
      if (existing.length) {
        await client.query(
          `UPDATE quotes SET is_superseded=TRUE
           WHERE ticker=$1 AND observation_ts=$2 AND is_superseded=FALSE`,
          [row.ticker, row.observation_ts],
        );
      }
      await client.query(
        `INSERT INTO quotes
           (ticker, observation_ts, knowledge_ts, bid, ask, mid, spread, spread_bps,
            bid_size, ask_size, market_state, source, is_synthetic, is_superseded, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,FALSE,$14)`,
        [
          row.ticker, row.observation_ts, row.knowledge_ts, row.bid, row.ask, row.mid,
          row.spread, row.spread_bps, row.bid_size, row.ask_size, row.market_state,
          row.source, row.is_synthetic, hash,
        ],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
