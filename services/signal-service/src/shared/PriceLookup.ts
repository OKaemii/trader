import type { Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import { getPgPool } from '@trader/shared-pg';
import type { IPriceLookup } from '../modules/signals/domain/IPriceLookup.ts';

// Bi-temporal price lookup. Dispatches between Mongo (legacy default) and
// Timescale (post-cutover) via `BARS_BACKEND`. Live reads (`asOf` omitted)
// filter `is_superseded:false`/`is_superseded = FALSE` and resolve to the
// partial-unique-index fast lane on either store. As-of reads aggregate per
// (ticker, observation_ts) picking the latest revision known at `asOf`.
//
// Renamed from MongoPriceLookup as part of agent-docs/plans/three-database-split.md.
// The Mongo-side aggregations are preserved verbatim so this is a zero-risk
// behavioural change on the default backend.

function activeBackend(): 'mongo' | 'timescale' {
  return (process.env.BARS_BACKEND ?? 'mongo') === 'timescale' ? 'timescale' : 'mongo';
}

export class PriceLookup implements IPriceLookup {
  constructor(private readonly db: Db) {}

  async lastClose(ticker: string, asOf?: number): Promise<number | null> {
    if (activeBackend() === 'timescale') return this._lastClosePg(ticker, asOf);
    return this._lastCloseMongo(ticker, asOf);
  }

  async lastCloseMany(tickers: string[], asOf?: number): Promise<Record<string, number | null>> {
    if (tickers.length === 0) return {};
    if (activeBackend() === 'timescale') return this._lastCloseManyPg(tickers, asOf);
    return this._lastCloseManyMongo(tickers, asOf);
  }

  // ── Mongo path ──────────────────────────────────────────────────────────────

  private async _lastCloseMongo(ticker: string, asOf?: number): Promise<number | null> {
    const coll = this.db.collection(COLLECTIONS.OHLCV_BARS);
    if (asOf === undefined) {
      const doc = await coll
        .find({ ticker, is_superseded: false })
        .sort({ observation_ts: -1 })
        .limit(1)
        .next();
      if (!doc) return null;
      const close = typeof doc.close === 'number' ? doc.close : null;
      return close && close > 0 ? close : null;
    }
    const docs = await coll.aggregate([
      { $match: { ticker, knowledge_ts: { $lte: asOf } } },
      { $sort: { observation_ts: -1, knowledge_ts: -1 } },
      { $group: { _id: '$observation_ts', close: { $first: '$close' } } },
      { $sort: { _id: -1 } },
      { $limit: 1 },
    ]).toArray();
    const row = docs[0];
    const close = row && typeof row.close === 'number' ? row.close : null;
    return close && close > 0 ? close : null;
  }

  private async _lastCloseManyMongo(tickers: string[], asOf?: number): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {};
    const coll = this.db.collection(COLLECTIONS.OHLCV_BARS);
    const match: Record<string, unknown> = { ticker: { $in: tickers } };
    if (asOf === undefined) match.is_superseded = false;
    else                    match.knowledge_ts  = { $lte: asOf };

    const cursor = coll.aggregate([
      { $match: match },
      { $sort: { observation_ts: -1, knowledge_ts: -1 } },
      { $group: { _id: '$ticker', close: { $first: '$close' } } },
    ]);
    for await (const row of cursor) {
      const close = typeof row.close === 'number' && row.close > 0 ? row.close : null;
      out[String(row._id)] = close;
    }
    for (const t of tickers) if (!(t in out)) out[t] = null;
    return out;
  }

  // ── Timescale path ──────────────────────────────────────────────────────────

  private async _lastClosePg(ticker: string, asOf?: number): Promise<number | null> {
    const pool = getPgPool();
    if (asOf === undefined) {
      // Live path — partial-unique-index fast lane.
      const { rows } = await pool.query<{ close: string }>(
        `SELECT close FROM bars
          WHERE ticker = $1 AND is_superseded = FALSE
          ORDER BY observation_ts DESC LIMIT 1`,
        [ticker],
      );
      const close = rows[0]?.close !== undefined ? Number(rows[0].close) : null;
      return close && close > 0 ? close : null;
    }
    // As-of path — distinct-on per observation_ts to pick the latest knowledge_ts
    // <= asOf, then take the most recent observation.
    const { rows } = await pool.query<{ close: string }>(
      `SELECT close FROM (
         SELECT DISTINCT ON (observation_ts) observation_ts, close
           FROM bars
          WHERE ticker = $1 AND knowledge_ts <= $2
          ORDER BY observation_ts DESC, knowledge_ts DESC
       ) sub
       LIMIT 1`,
      [ticker, asOf],
    );
    const close = rows[0]?.close !== undefined ? Number(rows[0].close) : null;
    return close && close > 0 ? close : null;
  }

  private async _lastCloseManyPg(tickers: string[], asOf?: number): Promise<Record<string, number | null>> {
    const pool = getPgPool();
    const out: Record<string, number | null> = {};

    if (asOf === undefined) {
      // Live path — one query, DISTINCT ON (ticker) picks the latest unsuperseded
      // observation per ticker.
      const { rows } = await pool.query<{ ticker: string; close: string }>(
        `SELECT DISTINCT ON (ticker) ticker, close
           FROM bars
          WHERE ticker = ANY($1::text[]) AND is_superseded = FALSE
          ORDER BY ticker, observation_ts DESC`,
        [tickers],
      );
      for (const row of rows) {
        const close = Number(row.close);
        out[row.ticker] = close > 0 ? close : null;
      }
    } else {
      // As-of path — first DISTINCT ON (ticker, observation_ts) to pick latest
      // knowledge_ts revision per observation, then DISTINCT ON (ticker) to pick
      // the latest observation per ticker.
      const { rows } = await pool.query<{ ticker: string; close: string }>(
        `SELECT DISTINCT ON (ticker) ticker, close
           FROM (
             SELECT DISTINCT ON (ticker, observation_ts)
                    ticker, observation_ts, close
               FROM bars
              WHERE ticker = ANY($1::text[]) AND knowledge_ts <= $2
              ORDER BY ticker, observation_ts, knowledge_ts DESC
           ) sub
          ORDER BY ticker, observation_ts DESC`,
        [tickers, asOf],
      );
      for (const row of rows) {
        const close = Number(row.close);
        out[row.ticker] = close > 0 ? close : null;
      }
    }

    for (const t of tickers) if (!(t in out)) out[t] = null;
    return out;
  }
}
