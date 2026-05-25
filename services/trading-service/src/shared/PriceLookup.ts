import type { Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import { getPgPool } from '@trader/shared-pg';
import type { Money, Currency } from '@trader/shared-types';

// Bi-temporal price lookup for trading-service. Dispatches between Mongo
// (legacy default) and Timescale (post-cutover) via `BARS_BACKEND`. Identical
// contract to the signal-service version plus a Money-tagged variant used by
// OrderDispatcher to size orders in instrument currency.
//
// Renamed from MongoPriceLookup as part of agent-docs/plans/three-database-split.md.

function activeBackend(): 'mongo' | 'timescale' {
  return (process.env.BARS_BACKEND ?? 'mongo') === 'timescale' ? 'timescale' : 'mongo';
}

// Currency-tagging fallback when the bar row didn't persist a `currency` field
// (pre-currency-persistence-fix data). Without this, untagged US bars would be
// mis-tagged GBP and the dispatcher would size orders by an FX factor —
// rounded down to 0 shares for almost every US signal. Inferred from the T212
// ticker suffix: `_US_EQ` → USD, anything else (`l_EQ` LSE / unsuffixed) → GBP.
function inferCurrency(ticker: string, persisted: unknown): Currency {
  if (persisted === 'USD' || persisted === 'GBP') return persisted;
  return /_US_EQ$/.test(ticker) ? 'USD' : 'GBP';
}

export class PriceLookup {
  constructor(private readonly db: Db) {}

  async lastClose(ticker: string, asOf?: number): Promise<number | null> {
    if (activeBackend() === 'timescale') return this._lastClosePg(ticker, asOf);
    return this._lastCloseMongo(ticker, asOf);
  }

  async lastCloseMoney(ticker: string, asOf?: number): Promise<Money | null> {
    if (activeBackend() === 'timescale') return this._lastCloseMoneyPg(ticker, asOf);
    return this._lastCloseMoneyMongo(ticker, asOf);
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

  private async _lastCloseMoneyMongo(ticker: string, asOf?: number): Promise<Money | null> {
    const coll = this.db.collection(COLLECTIONS.OHLCV_BARS);
    let doc: Record<string, unknown> | null;
    if (asOf === undefined) {
      doc = await coll
        .find({ ticker, is_superseded: false })
        .sort({ observation_ts: -1 })
        .limit(1)
        .next();
    } else {
      const docs = await coll.aggregate([
        { $match: { ticker, knowledge_ts: { $lte: asOf } } },
        { $sort: { observation_ts: -1, knowledge_ts: -1 } },
        { $group: { _id: '$observation_ts', close: { $first: '$close' }, currency: { $first: '$currency' } } },
        { $sort: { _id: -1 } },
        { $limit: 1 },
      ]).toArray();
      doc = (docs[0] as Record<string, unknown> | undefined) ?? null;
    }
    if (!doc) return null;
    const close = typeof doc.close === 'number' ? doc.close : null;
    if (!close || close <= 0) return null;
    return { amount: close, currency: inferCurrency(ticker, doc.currency) };
  }

  // ── Timescale path ──────────────────────────────────────────────────────────

  private async _lastClosePg(ticker: string, asOf?: number): Promise<number | null> {
    const pool = getPgPool();
    if (asOf === undefined) {
      const { rows } = await pool.query<{ close: string }>(
        `SELECT close FROM bars
          WHERE ticker = $1 AND is_superseded = FALSE
          ORDER BY observation_ts DESC LIMIT 1`,
        [ticker],
      );
      const close = rows[0]?.close !== undefined ? Number(rows[0].close) : null;
      return close && close > 0 ? close : null;
    }
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

  private async _lastCloseMoneyPg(ticker: string, asOf?: number): Promise<Money | null> {
    const pool = getPgPool();
    let row: { close: string; currency: string | null } | undefined;
    if (asOf === undefined) {
      const { rows } = await pool.query<{ close: string; currency: string | null }>(
        `SELECT close, currency FROM bars
          WHERE ticker = $1 AND is_superseded = FALSE
          ORDER BY observation_ts DESC LIMIT 1`,
        [ticker],
      );
      row = rows[0];
    } else {
      const { rows } = await pool.query<{ close: string; currency: string | null }>(
        `SELECT close, currency FROM (
           SELECT DISTINCT ON (observation_ts) observation_ts, close, currency
             FROM bars
            WHERE ticker = $1 AND knowledge_ts <= $2
            ORDER BY observation_ts DESC, knowledge_ts DESC
         ) sub
         LIMIT 1`,
        [ticker, asOf],
      );
      row = rows[0];
    }
    if (!row) return null;
    const close = Number(row.close);
    if (!close || close <= 0) return null;
    return { amount: close, currency: inferCurrency(ticker, row.currency) };
  }
}
