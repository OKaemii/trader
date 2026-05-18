import type { Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import type { Money, Currency } from '@trader/shared-types';

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

  // Money-tagged variant. Reads the bar's `currency` field; falls back to GBP for
  // legacy pre-FX rows. Safe because pence is normalised at the market-data boundary
  // so the only untagged bars in storage are GBP-listed equities. Used by the order
  // dispatcher to construct typed inputs for PlaceOrderUseCase — the type system then
  // refuses to compile any call site that forgets to FX-align NAV with price.
  async lastCloseMoney(ticker: string): Promise<Money | null> {
    const doc = await this.db.collection(COLLECTIONS.OHLCV_BARS)
      .find({ ticker })
      .sort({ timestamp: -1 })
      .limit(1)
      .next();
    if (!doc) return null;
    const close = typeof doc.close === 'number' ? doc.close : null;
    if (!close || close <= 0) return null;
    const ccy: Currency = (doc.currency === 'USD' || doc.currency === 'GBP') ? doc.currency : 'GBP';
    return { amount: close, currency: ccy };
  }
}
