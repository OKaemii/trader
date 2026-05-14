import type { Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';

export class MongoPriceLookup {
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
}
