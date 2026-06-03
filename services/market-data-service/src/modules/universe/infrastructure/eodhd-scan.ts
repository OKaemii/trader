// EODHD market-cap scan — the single universe SOURCE. Pages the EODHD screener across the
// requested exchanges (US + LSE), FX-normalises each name's market capitalisation to GBP, and
// keeps those >= minCapGbp. The result feeds UniverseManager, which maps to tradeable T212
// tickers and diffs into the ONE instrument_registry (no parallel pool).

import type { Currency } from '@trader/shared-types';
import { getEodhdClient, type EodhdExchange } from '../../bars/infrastructure/providers/eodhd-client.ts';
import { log } from '../../../logger.ts';

export type FxToGBP = (amount: number, currency: Currency) => Promise<number>;
const IDENTITY_FX: FxToGBP = async (amount) => amount;

export interface ScanCandidate {
  code:         string;     // EODHD bare code (e.g. 'AAPL', 'HSBA')
  name:         string;
  exchange:     string;     // 'US' | 'LSE'
  marketCapGbp: number;
}

export interface EodhdScanOpts {
  minCapGbp:       number;
  exchanges?:      EodhdExchange[];   // default ['US','LSE']
  fxToGBP?:        FxToGBP;
  maxPerExchange?: number;            // pagination safety cap (EODHD offset ceiling ≈ 1000)
}

const PAGE = 100;   // EODHD screener max page size

// EODHD market_capitalization is reported in the listing/major currency. Resolve it from the
// screener's currency_symbol, defaulting by exchange. (Pence labels still mean the major unit
// for a market-cap figure — cap is shares × price in the major currency, never quoted in pence.)
function capCurrency(exchange: string, currencySymbol?: string): Currency {
  if (currencySymbol === 'USD') return 'USD';
  if (currencySymbol === 'GBP' || currencySymbol === 'GBX' || currencySymbol === 'GBp') return 'GBP';
  return exchange.toUpperCase() === 'US' ? 'USD' : 'GBP';
}

export async function fetchEodhdCapScan(opts: EodhdScanOpts): Promise<ScanCandidate[]> {
  const exchanges = opts.exchanges ?? (['US', 'LSE'] as EodhdExchange[]);
  const fx = opts.fxToGBP ?? IDENTITY_FX;
  const maxPer = opts.maxPerExchange ?? 1000;
  const client = getEodhdClient();
  // Filter loosely in native units at half the GBP floor (covers the FX sanity-bound down to
  // GBPUSD=0.5 so we never miss a name near the threshold), then re-filter precisely in GBP.
  const nativeFloor = opts.minCapGbp * 0.5;
  const out: ScanCandidate[] = [];

  for (const ex of exchanges) {
    let added = 0;
    for (let offset = 0; offset < maxPer; offset += PAGE) {
      const rows = await client.screener(
        [['market_capitalization', '>', nativeFloor], ['exchange', '=', ex.toLowerCase()]],
        'market_capitalization.desc', PAGE, offset,
      );
      if (rows.length === 0) break;
      for (const r of rows) {
        const capGbp = await fx(r.marketCap, capCurrency(r.exchange || ex, r.currency));
        if (capGbp >= opts.minCapGbp) {
          out.push({ code: r.code, name: r.name, exchange: r.exchange || ex, marketCapGbp: capGbp });
          added++;
        }
      }
      if (rows.length < PAGE) break;   // last page
    }
    log.info(`[scanner] EODHD cap-scan ${ex}: ${added} names >= £${(opts.minCapGbp / 1e9).toFixed(1)}B`);
  }
  return out;
}
