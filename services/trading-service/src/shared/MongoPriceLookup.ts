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

  // Money-tagged variant. Reads the bar's `currency` field; when missing, infers from
  // the T212 ticker suffix (`_US_EQ` → USD, anything else → GBP — LSE l_EQ tickers are
  // GBP after the yahoo-client pence normalisation). Without this fallback, untagged US
  // bars (pre-currency-persistence-fix) would be mis-tagged GBP and dispatcher would
  // size orders by an FX factor → rounded down to 0 shares for almost every US signal.
  async lastCloseMoney(ticker: string): Promise<Money | null> {
    const doc = await this.db.collection(COLLECTIONS.OHLCV_BARS)
      .find({ ticker })
      .sort({ timestamp: -1 })
      .limit(1)
      .next();
    if (!doc) return null;
    const close = typeof doc.close === 'number' ? doc.close : null;
    if (!close || close <= 0) return null;
    let ccy: Currency;
    if (doc.currency === 'USD' || doc.currency === 'GBP') {
      ccy = doc.currency;
    } else {
      ccy = /_US_EQ$/.test(ticker) ? 'USD' : 'GBP';
    }
    return { amount: close, currency: ccy };
  }
}
