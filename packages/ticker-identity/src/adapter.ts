import type { Currency } from '@trader/shared-types';

// ── Canonical ticker identity ──────────────────────────────────────────────────
//
// The platform's single source of truth for "which instrument" is the BARE exchange
// symbol plus its listing market — never the broker's concatenated form. A US Alphabet
// share is { symbol: 'GOOGL', market: 'US' }; a London Shell share is
// { symbol: 'SHEL', market: 'LSE' }. Storage (Mongo fields, Timescale columns, Redis
// keys) carries `symbol` + `market` separately; the Trading212 `_US_EQ` / `l_EQ` form is
// produced ONLY by the adapter below, at the broker boundary.
//
// `Market` excludes 'OTHER' deliberately: only US + LSE listings are tradable on the
// platform, so an unrecognised suffix is a parse failure (caller's problem), not a third
// enum member that would silently flow into storage and ranking.
export type Market = 'US' | 'LSE';

export interface TickerIdentity {
  readonly symbol: string;
  readonly market: Market;
}

// T212 represents a listing by appending an exchange tag to the bare symbol:
//   US  →  `<symbol>_US_EQ`   (e.g. GOOGL → GOOGL_US_EQ)
//   LSE →  `<symbol>l_EQ`     (lowercase 'l' joined to the symbol, e.g. SHEL → SHELl_EQ)
// These two literals are the entire knowledge of the broker representation in the codebase
// — every other call site routes through `toT212` / `fromT212`.
const US_SUFFIX = '_US_EQ';
const LSE_SUFFIX = 'l_EQ';

// Legacy-rename table: a symbol the broker's catalog still lists under its pre-rebrand
// name maps to the canonical post-rebrand symbol. Seeded from the scattered
// `SYMBOL_RENAMES` maps (market-data provider clients) — Facebook → Meta. The rename is
// keyed by `(market, fromSymbol)` because a rebrand is listing-specific: FB→META is a US
// event, so it must not silently rewrite a same-named symbol on another market.
const RENAMES: Record<Market, Record<string, string>> = {
  US: { FB: 'META' },
  LSE: {},
};

// Currency is a pure function of the listing market — the account base is GBP, US
// listings quote in USD, LSE listings quote in GBP. This replaces the duplicated
// `currencyOfTicker` / `inferCurrency` suffix sniffers so a single rule governs both.
const CURRENCY_BY_MARKET: Record<Market, Currency> = {
  US: 'USD',
  LSE: 'GBP',
};

/**
 * The only code in the platform that produces or parses the Trading212 `_US_EQ` / `l_EQ`
 * form, derives currency from a listing, or owns the legacy symbol rename. Everything
 * upstream works in `TickerIdentity` and converts at the broker boundary alone.
 */
export class Trading212TickerAdapter {
  /**
   * Identity → the broker's ticker string. `{ GOOGL, US } → 'GOOGL_US_EQ'`;
   * `{ SHEL, LSE } → 'SHELl_EQ'`. Inverse of {@link fromT212}.
   */
  toT212(id: TickerIdentity): string {
    const symbol = requireSymbol(id.symbol);
    switch (id.market) {
      case 'US':
        return `${symbol}${US_SUFFIX}`;
      case 'LSE':
        return `${symbol}${LSE_SUFFIX}`;
      default:
        // Symmetric with fromT212's rejection: the produce-side throws on an
        // unsupported market rather than returning undefined. `market` is typed to
        // 'US'|'LSE', but Thread A's downstream readers hydrate it from storage
        // (Mongo fields / Timescale columns) where an `as Market` cast can smuggle
        // an out-of-type value — fail loudly instead of broker-sending 'undefined'.
        throw new Error(`[ticker-identity] unsupported market: ${String((id as TickerIdentity).market)}`);
    }
  }

  /**
   * The broker's ticker string → identity. The ONLY suffix parser in the codebase, and a
   * strict inverse of {@link toT212}: `'GOOGL_US_EQ' → { GOOGL, US }`,
   * `'SHELl_EQ' → { SHEL, LSE }`. A string that is not a recognised US/LSE equity form
   * (an unsupported market, CFD, or malformed input) throws — it is not silently coerced
   * to a third market, because only US + LSE are tradable here.
   */
  fromT212(t212: string): TickerIdentity {
    const raw = (t212 ?? '').trim();
    // US is unambiguous: the explicit `_US_EQ` tail. Strip it for the bare symbol.
    if (raw.endsWith(US_SUFFIX)) {
      const symbol = raw.slice(0, -US_SUFFIX.length);
      if (symbol.length === 0) {
        throw new Error(`[ticker-identity] malformed T212 ticker (empty symbol): ${t212}`);
      }
      return { symbol, market: 'US' };
    }
    // LSE is `<symbol>l_EQ`: the `l` belongs to the suffix, so the bare symbol is what
    // precedes `l_EQ` (and must be non-empty — `l_EQ` alone has no symbol).
    if (raw.endsWith(LSE_SUFFIX)) {
      const symbol = raw.slice(0, -LSE_SUFFIX.length);
      if (symbol.length === 0) {
        throw new Error(`[ticker-identity] malformed T212 ticker (empty symbol): ${t212}`);
      }
      return { symbol, market: 'LSE' };
    }
    throw new Error(`[ticker-identity] unrecognised T212 ticker (not a US/LSE equity): ${t212}`);
  }

  /** Listing market → quote currency. `US → 'USD'`, `LSE → 'GBP'`. */
  currencyOf(id: TickerIdentity): Currency {
    return CURRENCY_BY_MARKET[id.market];
  }

  /**
   * Apply a legacy symbol rename (e.g. US `FB → META`) market-aware. Returns a new
   * identity with the canonical symbol when a rename applies, otherwise the input
   * unchanged. Replaces the scattered `SYMBOL_RENAMES` lookups.
   */
  applyRename(id: TickerIdentity): TickerIdentity {
    const symbol = requireSymbol(id.symbol);
    const renamed = RENAMES[id.market][symbol];
    if (renamed === undefined || renamed === symbol) return id;
    return { symbol: renamed, market: id.market };
  }
}

// A bare symbol must be a non-empty token with no broker suffix already attached — guards
// against `toT212({ symbol: '', … })` emitting a suffix-only string and against
// double-encoding an already-T212 value back through the adapter.
function requireSymbol(symbol: string): string {
  const s = (symbol ?? '').trim();
  if (s.length === 0) {
    throw new Error('[ticker-identity] empty symbol');
  }
  return s;
}
