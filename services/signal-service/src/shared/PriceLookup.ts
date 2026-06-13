import type { Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import { getPgPool } from '@trader/shared-pg';
import { Trading212TickerAdapter } from '@trader/ticker-identity';
import type { IPriceLookup } from '../modules/signals/domain/IPriceLookup.ts';

// Bi-temporal price lookup. Dispatches between Mongo (legacy default) and
// Timescale (post-cutover) via `BARS_BACKEND`. Live reads (`asOf` omitted)
// filter `is_superseded:false`/`is_superseded = FALSE` and resolve to the
// partial-unique-index fast lane on either store. As-of reads aggregate per
// observation_ts picking the latest revision known at `asOf`.
//
// Renamed from MongoPriceLookup as part of agent-docs/plans/three-database-split.md.
// Storage is keyed on the bare identity (symbol, market) since Thread A (Task 15); the public
// methods still accept a T212 ticker during the transition and split it at the storage boundary via
// the platform's single suffix parser. The aggregation/SQL shapes are otherwise unchanged.

function activeBackend(): 'mongo' | 'timescale' {
  return (process.env.BARS_BACKEND ?? 'mongo') === 'timescale' ? 'timescale' : 'mongo';
}

const tickerAdapter = new Trading212TickerAdapter();

// Split a batch of T212 tickers to their (symbol, market) identities, fail-soft: a ticker that does
// not parse as a US/LSE equity (a stale override, a delisted/renamed name persisted in an old signal)
// is dropped from the storage query rather than throwing the whole batch — the caller's
// `if (!(t in out)) out[t]=null` backfill then reports it as null, matching the pre-Thread-A
// `{$in}` / `ANY()` behaviour where an unknown ticker simply produced no match.
function splitBatch(tickers: string[]): Array<{ ticker: string; symbol: string; market: string }> {
  const out: Array<{ ticker: string; symbol: string; market: string }> = [];
  for (const ticker of tickers) {
    try { const { symbol, market } = tickerAdapter.fromT212(ticker); out.push({ ticker, symbol, market }); }
    catch { /* unparseable → omitted; reported null by the caller's backfill */ }
  }
  return out;
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
    const { symbol, market } = tickerAdapter.fromT212(ticker);
    if (asOf === undefined) {
      const doc = await coll
        .find({ symbol, market, is_superseded: false })
        .sort({ observation_ts: -1 })
        .limit(1)
        .next();
      if (!doc) return null;
      const close = typeof doc.close === 'number' ? doc.close : null;
      return close && close > 0 ? close : null;
    }
    const docs = await coll.aggregate([
      { $match: { symbol, market, knowledge_ts: { $lte: asOf } } },
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
    // Split each requested ticker to its identity (fail-soft); key results back to the original
    // ticker so the returned record's keys are unchanged for callers.
    const ids = splitBatch(tickers);
    if (ids.length === 0) { for (const t of tickers) out[t] = null; return out; }
    const tickerByIdentity = new Map(ids.map((i) => [`${i.symbol}|${i.market}`, i.ticker]));
    const match: Record<string, unknown> = { $or: ids.map((i) => ({ symbol: i.symbol, market: i.market })) };
    if (asOf === undefined) match.is_superseded = false;
    else                    match.knowledge_ts  = { $lte: asOf };

    const cursor = coll.aggregate([
      { $match: match },
      { $sort: { observation_ts: -1, knowledge_ts: -1 } },
      { $group: { _id: { symbol: '$symbol', market: '$market' }, close: { $first: '$close' } } },
    ]);
    for await (const row of cursor) {
      const close = typeof row.close === 'number' && row.close > 0 ? row.close : null;
      const t = tickerByIdentity.get(`${row._id.symbol}|${row._id.market}`);
      if (t !== undefined) out[t] = close;
    }
    for (const t of tickers) if (!(t in out)) out[t] = null;
    return out;
  }

  // ── Timescale path ──────────────────────────────────────────────────────────

  private async _lastClosePg(ticker: string, asOf?: number): Promise<number | null> {
    const pool = getPgPool();
    const { symbol, market } = tickerAdapter.fromT212(ticker);
    if (asOf === undefined) {
      // Live path — partial-unique-index fast lane.
      const { rows } = await pool.query<{ close: string }>(
        `SELECT close FROM bars
          WHERE symbol = $1 AND market = $2 AND is_superseded = FALSE
          ORDER BY observation_ts DESC LIMIT 1`,
        [symbol, market],
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
          WHERE symbol = $1 AND market = $2 AND knowledge_ts <= $3
          ORDER BY observation_ts DESC, knowledge_ts DESC
       ) sub
       LIMIT 1`,
      [symbol, market, asOf],
    );
    const close = rows[0]?.close !== undefined ? Number(rows[0].close) : null;
    return close && close > 0 ? close : null;
  }

  private async _lastCloseManyPg(tickers: string[], asOf?: number): Promise<Record<string, number | null>> {
    const pool = getPgPool();
    const out: Record<string, number | null> = {};
    // Split each ticker (fail-soft); the (symbol, market) membership replaces the single-column
    // ANY(). Results come back keyed by (symbol, market) and re-keyed to the caller's tickers.
    const ids = splitBatch(tickers);
    if (ids.length === 0) { for (const t of tickers) out[t] = null; return out; }
    const symbols = ids.map((i) => i.symbol);
    const markets = ids.map((i) => i.market);
    const tickerByIdentity = new Map(ids.map((i) => [`${i.symbol}|${i.market}`, i.ticker]));

    if (asOf === undefined) {
      // Live path — one query, DISTINCT ON (symbol, market) picks the latest unsuperseded
      // observation per name.
      const { rows } = await pool.query<{ symbol: string; market: string; close: string }>(
        `SELECT DISTINCT ON (symbol, market) symbol, market, close
           FROM bars
          WHERE (symbol, market) IN (SELECT unnest($1::text[]), unnest($2::text[]))
            AND is_superseded = FALSE
          ORDER BY symbol, market, observation_ts DESC`,
        [symbols, markets],
      );
      for (const row of rows) {
        const close = Number(row.close);
        const t = tickerByIdentity.get(`${row.symbol}|${row.market}`);
        if (t !== undefined) out[t] = close > 0 ? close : null;
      }
    } else {
      // As-of path — first DISTINCT ON (symbol, market, observation_ts) to pick latest
      // knowledge_ts revision per observation, then DISTINCT ON (symbol, market) to pick
      // the latest observation per name.
      const { rows } = await pool.query<{ symbol: string; market: string; close: string }>(
        `SELECT DISTINCT ON (symbol, market) symbol, market, close
           FROM (
             SELECT DISTINCT ON (symbol, market, observation_ts)
                    symbol, market, observation_ts, close
               FROM bars
              WHERE (symbol, market) IN (SELECT unnest($1::text[]), unnest($2::text[]))
                AND knowledge_ts <= $3
              ORDER BY symbol, market, observation_ts, knowledge_ts DESC
           ) sub
          ORDER BY symbol, market, observation_ts DESC`,
        [symbols, markets, asOf],
      );
      for (const row of rows) {
        const close = Number(row.close);
        const t = tickerByIdentity.get(`${row.symbol}|${row.market}`);
        if (t !== undefined) out[t] = close > 0 ? close : null;
      }
    }

    for (const t of tickers) if (!(t in out)) out[t] = null;
    return out;
  }
}
