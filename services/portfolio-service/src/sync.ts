import type { Currency, Money } from '@trader/shared-types';

// Pure builder for the Mongo position document. Extracted so the regression test
// can lock the schema shape without spinning up Mongo or Hono:
//   - $set never includes `currentValueGBP` (the legacy dual-write field)
//   - $unset always clears `currentValueGBP` to make the migration self-healing
//   - currentPrice and currentValue are Money-shaped (instrument currency)
export interface PositionUpdate {
  $set: {
    ticker:       string;
    quantity:     number;
    currency:     Currency;
    currentPrice: Money;
    currentValue: Money;
    weight:       number;
    updatedAt:    Date;
  };
  $unset: {
    currentValueGBP: '';
  };
}

export function buildPositionUpdate(args: {
  ticker:       string;
  quantity:     number;
  currency:     Currency;
  priceNative:  number;
  valueNative:  number;
  weight:       number;
  now?:         () => Date;
}): PositionUpdate {
  const now = (args.now ?? (() => new Date()))();
  return {
    $set: {
      ticker:       args.ticker,
      quantity:     args.quantity,
      currency:     args.currency,
      currentPrice: { amount: args.priceNative, currency: args.currency },
      currentValue: { amount: args.valueNative, currency: args.currency },
      weight:       args.weight,
      updatedAt:    now,
    },
    $unset: {
      currentValueGBP: '',
    },
  };
}
