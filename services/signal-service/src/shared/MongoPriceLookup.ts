import type { Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import type { IPriceLookup } from '../modules/signals/domain/IPriceLookup.ts';

// Reads the most recent close from the ohlcv_bars collection. The market-data-service
// already maintains a (ticker, timestamp) index — this is a cheap point lookup.
export class MongoPriceLookup implements IPriceLookup {
  constructor(private readonly db: Db) {}

  async lastClose(ticker: string): Promise<number | null> {
    const doc = await this.db.collection(COLLECTIONS.OHLCV_BARS)
      .find({ ticker })
      .sort({ timestamp: -1 })
      .limit(1)
      .next();
    if (!doc) return null;
    const close = typeof doc.close === 'number' ? doc.close : null;
    return close && close > 0 ? close : null;
  }

  async lastCloseMany(tickers: string[]): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {};
    if (tickers.length === 0) return out;
    // One round trip: aggregate the latest bar per ticker via $sort + $group.
    const cursor = this.db.collection(COLLECTIONS.OHLCV_BARS).aggregate([
      { $match: { ticker: { $in: tickers } } },
      { $sort: { timestamp: -1 } },
      { $group: { _id: '$ticker', close: { $first: '$close' } } },
    ]);
    for await (const row of cursor) {
      const close = typeof row.close === 'number' && row.close > 0 ? row.close : null;
      out[String(row._id)] = close;
    }
    // Ensure every requested ticker has a key, even if missing in OHLCV.
    for (const t of tickers) if (!(t in out)) out[t] = null;
    return out;
  }
}
