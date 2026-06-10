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

// Ticker renames where the EODHD post-rebrand CODE is the SAME symbol the broker now lists, but
// the broker's instrument feed may still echo the pre-rebrand shortName for back-compat. Keyed by
// the EODHD code; the value is the LEGACY shortName to ALSO try when indexing the T212 catalog.
//   FB→META: Trading212 renamed the instrument FB→META in 2021 (operator-confirmed); META_US_EQ is
//   the correct, orderable T212 ticker (it coincides with EDGAR CIK 0001326801). The prior
//   REVERSE_RENAMES={META:'FB'} forced Meta back to the dead FB_US_EQ — that was the bug: it
//   trusted a stale pre-2021 assumption over the live broker reality. We still try the legacy `FB`
//   shortName so Meta resolves even if the broker's metadata lags, but we EMIT the canonical
//   `META_US_EQ` (built from the EODHD code below), never the stale matched ticker.
const EODHD_CODE_TO_LEGACY_SHORTNAME: Record<string, string> = { META: 'FB' };

// Build the canonical, orderable T212 ticker for an EODHD code in the given market. The universe
// ticker IS the order ticker (it flows registry→market:raw→signal→OrderDispatcher→T212 unchanged),
// so it must be the broker's CURRENT listing form — `SYMBOL_US_EQ` (US) / `SYMBOLl_EQ` (LSE).
function canonicalT212Ticker(code: string, market: 'US' | 'LSE'): string {
  return market === 'US' ? `${code}_US_EQ` : `${code}l_EQ`;
}

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
    // Index the broker catalog by the CURRENT code first, then any legacy shortName the broker may
    // still echo for a renamed instrument — so we locate the row (for its name) regardless of which
    // shortName the broker returns. A renamed code ALWAYS emits the canonical ticker (e.g. the
    // EODHD `META` candidate → `META_US_EQ`), decoupling "which shortName T212 returned" from the
    // orderable ticker; a row matched only via the legacy shortName must not resurrect the dead one.
    const legacy = EODHD_CODE_TO_LEGACY_SHORTNAME[code];
    const lookups = legacy ? [code, legacy] : [code];
    let inst: T212Instrument | undefined;
    for (const l of lookups) { inst = byMarket[market][l]; if (inst) break; }
    if (!inst) { dropped++; continue; }
    const ticker = legacy ? canonicalT212Ticker(code, market) : inst.ticker;
    mapped.push({
      ticker,
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
