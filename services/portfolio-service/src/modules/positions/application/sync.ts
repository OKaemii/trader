import type { Currency, Money } from '@trader/shared-types';

// Pure builder for the Mongo position document. Extracted so the regression test
// can lock the schema shape without spinning up Mongo or Hono:
//   - the position is keyed on the bare (symbol, market) identity since Task 16a — the
//     concatenated T212 `ticker` is no longer stored (the caller splits it at the sync boundary)
//   - $set never includes `currentValueGBP` (the legacy dual-write field)
//   - $unset always clears `currentValueGBP` to make the migration self-healing
//   - currentPrice and currentValue are Money-shaped (instrument currency)
export interface PositionUpdate {
  $set: {
    symbol:        string;
    market:        string;
    quantity:      number;
    currency:      Currency;
    currentPrice:  Money;
    currentValue:  Money;
    weight:        number;
    updatedAt:     Date;
    averagePrice?: Money;   // cost basis per share (instrument currency) — drives open P&L
  };
  $unset: {
    currentValueGBP: '';
    ticker:          '';   // drop the legacy concatenated-ticker field so pre-Thread-A rows self-heal
  };
}

export function buildPositionUpdate(args: {
  symbol:        string;
  market:        string;
  quantity:      number;
  currency:      Currency;
  priceNative:   number;
  valueNative:   number;
  weight:        number;
  avgPriceNative?: number | undefined;   // omitted when T212 doesn't report a cost basis
  now?:          () => Date;
}): PositionUpdate {
  const now = (args.now ?? (() => new Date()))();
  return {
    $set: {
      symbol:       args.symbol,
      market:       args.market,
      quantity:     args.quantity,
      currency:     args.currency,
      currentPrice: { amount: args.priceNative, currency: args.currency },
      currentValue: { amount: args.valueNative, currency: args.currency },
      weight:       args.weight,
      updatedAt:    now,
      ...(args.avgPriceNative != null && args.avgPriceNative > 0
        ? { averagePrice: { amount: args.avgPriceNative, currency: args.currency } }
        : {}),
    },
    $unset: {
      currentValueGBP: '',
      ticker:          '',
    },
  };
}
