// Reverse symbol mapping: EODHD screener candidates (CODE + EXCHANGE) -> the tradeable
// Trading212 ticker. Names T212 doesn't carry are dropped (only executable tickers may enter
// the single active universe). Indexing mirrors UniverseManager.selectCurated: US prefers
// `_US_EQ`, LSE prefers GBP/GBX `l_EQ`, matched on T212 shortName.

import type { T212Instrument } from './t212-client.ts';
import type { ScanCandidate } from './eodhd-scan.ts';
import { log } from '../../../logger.ts';

export interface ScannedInstrument {
  ticker:       string;     // T212 ticker (tradeable)
  eodhdSymbol:  string;     // CODE.EXCHANGE
  name:         string;
  marketCapGbp: number;
  market:       'US' | 'LSE';
  sector?:      string;     // carried from the EODHD screener candidate
}

function indexByMarket(rawInstruments: T212Instrument[]): {
  US: Record<string, T212Instrument>;
  LSE: Record<string, T212Instrument>;
} {
  const byMarket = { US: {} as Record<string, T212Instrument>, LSE: {} as Record<string, T212Instrument> };
  for (const inst of rawInstruments) {
    const sn = inst.shortName?.toUpperCase();
    if (!sn) continue;
    const isUS  = /_US_EQ$/.test(inst.ticker);
    const isLSE = /l_EQ$/.test(inst.ticker) && (inst.currencyCode === 'GBP' || inst.currencyCode === 'GBX');
    if (isUS && !byMarket.US[sn]) byMarket.US[sn] = inst;
    if (isLSE && !byMarket.LSE[sn]) byMarket.LSE[sn] = inst;
  }
  return byMarket;
}

const EODHD_EXCHANGE_TO_MARKET: Record<string, 'US' | 'LSE'> = { US: 'US', LSE: 'LSE' };
// EODHD uses post-rebrand codes (META); T212 keeps the pre-rebrand shortName (FB). Reverse of
// the forward SYMBOL_RENAMES in eodhd-client.
const REVERSE_RENAMES: Record<string, string> = { META: 'FB' };

export function mapEodhdToT212(
  candidates: ScanCandidate[],
  rawInstruments: T212Instrument[],
): { mapped: ScannedInstrument[]; dropped: number } {
  const byMarket = indexByMarket(rawInstruments);
  const mapped: ScannedInstrument[] = [];
  let dropped = 0;
  for (const c of candidates) {
    const market = EODHD_EXCHANGE_TO_MARKET[c.exchange.toUpperCase()];
    if (!market) { dropped++; continue; }
    const code = c.code.toUpperCase();
    const lookups = REVERSE_RENAMES[code] ? [code, REVERSE_RENAMES[code]!] : [code];
    let inst: T212Instrument | undefined;
    for (const l of lookups) { inst = byMarket[market][l]; if (inst) break; }
    if (!inst) { dropped++; continue; }
    mapped.push({
      ticker:       inst.ticker,
      eodhdSymbol:  `${c.code}.${c.exchange}`,
      name:         c.name || inst.name,
      marketCapGbp: c.marketCapGbp,
      market,
      ...(c.sector ? { sector: c.sector } : {}),
    });
  }
  if (dropped) log.info(`[scanner] EODHD->T212 map: ${mapped.length} tradeable, ${dropped} dropped (not on T212 / unknown exchange)`);
  return { mapped, dropped };
}
