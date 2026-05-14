// Static GICS sector fallback. T212's instruments API does not return sector data, so
// universe-manager tags every ticker as 'Unknown'. This map is consulted when the live
// sectorMap has no useful entry — purely a display nicety; trading logic doesn't read it.
//
// Keep entries sorted alphabetically and prefer the GICS sector name (not industry).
// Tickers stored as the bare symbol; matchers below strip T212's `_US_EQ` / exchange
// suffixes before lookup.

const STATIC_SECTORS: Record<string, string> = {
  AAPL:  'Information Technology',
  ABNB:  'Consumer Discretionary',
  AMD:   'Information Technology',
  AMZN:  'Consumer Discretionary',
  AVGO:  'Information Technology',
  BAC:   'Financials',
  BRK:   'Financials',
  COST:  'Consumer Staples',
  CRM:   'Information Technology',
  DIS:   'Communication Services',
  GOOG:  'Communication Services',
  GOOGL: 'Communication Services',
  HD:    'Consumer Discretionary',
  INTC:  'Information Technology',
  JNJ:   'Health Care',
  JPM:   'Financials',
  KO:    'Consumer Staples',
  LLY:   'Health Care',
  MA:    'Financials',
  META:  'Communication Services',
  MRK:   'Health Care',
  MSFT:  'Information Technology',
  NFLX:  'Communication Services',
  NKE:   'Consumer Discretionary',
  NVDA:  'Information Technology',
  ORCL:  'Information Technology',
  PEP:   'Consumer Staples',
  PFE:   'Health Care',
  PG:    'Consumer Staples',
  TSLA:  'Consumer Discretionary',
  UNH:   'Health Care',
  V:     'Financials',
  WMT:   'Consumer Staples',
  XOM:   'Energy',

  // LSE ETFs commonly held in the bootstrap universe
  IUKD:  'ETF — UK Equity',
  SGLN:  'ETF — Commodity',
  SRSA:  'ETF — Global Equity',
  SSLN:  'ETF — Commodity',
  SUPR:  'ETF — UK Equity',
  VFEM:  'ETF — Emerging Markets',
  XUSE:  'ETF — US Equity',
}

// T212 portfolio tickers commonly carry suffixes like `AAPL_US_EQ`, `AAPLl_EQ`, or
// `TSLA.O`. Strip everything from the first non-letter character so the lookup keys
// stay as plain symbols. Lowercase letters in the symbol body (T212 sometimes adds
// `l` for London listings, e.g. `AAPLl_EQ`) are removed too.
function normaliseTicker(ticker: string): string {
  const upper = ticker.toUpperCase()
  const m = upper.match(/^[A-Z]+/)
  if (!m) return upper
  // Drop the trailing London-listing lowercase suffix that survives upper-casing
  // by stripping anything past the first symbol break. AAPLL_EQ → AAPLL → AAPL.
  // We can't generally distinguish `AAPLL` (London dual-list) from a real symbol,
  // so try the trimmed form only if the full form misses.
  return m[0]
}

export function resolveSector(
  ticker: string | undefined,
  liveMap: Record<string, string>,
): string {
  if (!ticker) return 'Unknown'
  const live = liveMap[ticker]
  if (live && live !== 'Unknown') return live

  const norm = normaliseTicker(ticker)
  if (STATIC_SECTORS[norm]) return STATIC_SECTORS[norm]

  // Try one more time after dropping a trailing 'L' (T212 London listing marker)
  if (norm.endsWith('L') && norm.length > 1) {
    const trimmed = norm.slice(0, -1)
    if (STATIC_SECTORS[trimmed]) return STATIC_SECTORS[trimmed]
  }

  return live ?? 'Unknown'
}
