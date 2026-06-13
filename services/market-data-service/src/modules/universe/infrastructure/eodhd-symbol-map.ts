// Reverse symbol mapping: EODHD screener candidates (CODE + EXCHANGE) -> the bare (symbol, market)
// identity. Names T212 doesn't carry are dropped (only executable instruments may enter the single
// active universe). Indexing mirrors UniverseManager.selectCurated: US prefers `_US_EQ`, LSE prefers
// GBP/GBX `l_EQ`, matched on T212 shortName.
//
// Native to the bare identity (Task 18): mapEodhdToT212 now emits `{ symbol, market }` (its name is
// kept for call-site continuity — the universe build is `(symbol, market)` natively, and the T212
// string is produced only at the broker boundary). The EODHD post-rebrand code is reconciled to the
// canonical symbol via the Trading212TickerAdapter's market-aware rename (FB→META), so the scan seam
// no longer carries its own rename table.

import { Trading212TickerAdapter } from '@trader/ticker-identity';
import type { T212Instrument } from './t212-client.ts';
import type { ScanCandidate } from './eodhd-scan.ts';
import { log } from '../../../logger.ts';

export interface ScannedInstrument {
  symbol:       string;     // bare exchange symbol (canonical, post-rename)
  market:       'US' | 'LSE';
  eodhdSymbol:  string;     // CODE.EXCHANGE
  name:         string;
  marketCapGbp: number;
  sector?:      string;     // carried from the EODHD screener candidate
}

const adapter = new Trading212TickerAdapter();

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

// Ticker renames where the EODHD post-rebrand CODE is the SAME symbol the broker now lists, but the
// broker's instrument feed may still echo the pre-rebrand shortName for back-compat. Derived from the
// adapter's market-aware rename table by inverting it per market: the value is the LEGACY shortName to
// ALSO try when indexing the T212 catalog so we LOCATE the row even when the broker's metadata lags.
//   FB→META: Trading212 renamed the instrument FB→META in 2021 (operator-confirmed); META is the
//   canonical, orderable symbol (it coincides with EDGAR CIK 0001326801). We still try the legacy `FB`
//   shortName so Meta resolves even if the broker's metadata lags, but we EMIT the canonical `META`
//   identity (via the adapter rename), never the stale matched symbol.
function legacyShortNameFor(code: string, market: 'US' | 'LSE'): string | undefined {
  // Invert applyRename: the legacy shortName is whichever symbol renames TO this code.
  const canonical = adapter.applyRename({ symbol: code, market }).symbol;
  if (canonical !== code) return undefined;   // `code` is itself a legacy symbol — handled by direct match
  // Probe the small known set for a legacy alias of this canonical code (only FB→META today).
  for (const legacy of LEGACY_PROBE) {
    if (adapter.applyRename({ symbol: legacy, market }).symbol === code) return legacy;
  }
  return undefined;
}

// The legacy symbols the adapter rename knows about (the LHS of the rename table). Kept narrow; extend
// alongside the adapter's RENAMES if another rebrand needs the broker-catalog back-compat probe.
const LEGACY_PROBE = ['FB'] as const;

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
    // Canonical symbol = the EODHD code with the adapter's market-aware rename applied (FB→META is a
    // no-op for a code already post-rebrand). Index the broker catalog by the CURRENT code first, then
    // any legacy shortName the broker may still echo for a renamed instrument — so we LOCATE the row
    // (for its name) regardless of which shortName the broker returns. A renamed code ALWAYS emits the
    // canonical identity; a row matched only via the legacy shortName must not resurrect the dead one.
    const symbol = adapter.applyRename({ symbol: code, market }).symbol;
    const legacy = legacyShortNameFor(code, market);
    const lookups = legacy ? [code, legacy] : [code];
    let inst: T212Instrument | undefined;
    for (const l of lookups) { inst = byMarket[market][l]; if (inst) break; }
    if (!inst) { dropped++; continue; }
    mapped.push({
      symbol,
      market,
      eodhdSymbol:  `${c.code}.${c.exchange}`,
      name:         c.name || inst.name,
      marketCapGbp: c.marketCapGbp,
      ...(c.sector ? { sector: c.sector } : {}),
    });
  }
  if (dropped) log.info(`[scanner] EODHD->identity map: ${mapped.length} tradeable, ${dropped} dropped (not on T212 / unknown exchange)`);
  return { mapped, dropped };
}
