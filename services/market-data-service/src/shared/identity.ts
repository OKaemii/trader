// market-data-service — the Mongo storage-boundary ticker↔identity bridge (Thread A, Task 16b).
//
// The universe + market-data documents (`instrument_registry`, `factor_scores`,
// `company_fundamentals`, `corporate_actions`, `earnings_calendar`, `index_constituents`,
// `portal_universe_overrides`) are keyed on the BARE identity — `symbol` + `market` — never the
// concatenated Trading212 `ticker`. The in-memory domain (UniverseManager builds T212 tickers
// internally; the admin/scanner routes and the internal/* contracts still pass T212 strings) keeps
// working in the T212 ticker during the Thread A transition: this module is the single place that
// splits a T212 ticker into a TickerIdentity before any Mongo touch, and re-joins it on the way out
// so a read reconstructs the same `ticker` the writer started with. The universe-BUILDING logic and
// the provider routers migrate natively in Task 18 — here only the Mongo storage SHAPE moves.
//
// `Trading212TickerAdapter.fromT212` is the platform's single suffix parser; it throws on a form
// that is neither a US (`_US_EQ`) nor an LSE (`l_EQ`) equity. Mirroring the shared-bars / signal-
// service bridges, queries and reads are fail-soft — a stale/renamed/delisted ticker persisted in an
// old doc must degrade (no match / skip), never throw the whole batch.

import { Trading212TickerAdapter, type Market, type TickerIdentity } from '@trader/ticker-identity';
import type { Currency } from '@trader/shared-types';

const adapter = new Trading212TickerAdapter();

/** Split a T212 ticker into its bare `(symbol, market)` identity. Throws on a non-US/LSE form. */
export function identityOf(ticker: string): TickerIdentity {
  return adapter.fromT212(ticker);
}

/**
 * Split a T212 ticker fail-soft: returns `(symbol, market)` or `null` when the ticker is not a
 * recognised US/LSE equity. Every Mongo write/query call site uses this so a single un-routable name
 * (an OTHER/CFD/legacy string) is skipped rather than throwing the whole batch — preserving the
 * pre-Thread-A behaviour where an unknown ticker simply produced no match.
 */
export function tryIdentityOf(ticker: string): TickerIdentity | null {
  try { return adapter.fromT212(ticker); } catch { return null; }
}

/** Re-derive the T212 ticker from a `(symbol, market)` pair — the inverse of {@link identityOf}. */
export function tickerOf(symbol: string, market: string): string {
  return adapter.toT212({ symbol, market: market as Market });
}

/**
 * Split a batch of T212 tickers to their bare `{ symbol, market }` identities, dropping any that
 * don't parse to a US/LSE form (fail-soft). The storage-shape projection for the document fields
 * `portal_universe_overrides` (and similar) persist — the inverse direction is handled per call site
 * (`tryIdentityOf`/`tickerOf`).
 */
export function tickersToIdentities(tickers: string[]): TickerIdentity[] {
  const out: TickerIdentity[] = [];
  for (const t of tickers) {
    const id = tryIdentityOf(t);
    if (id !== null) out.push(id);
  }
  return out;
}

/**
 * The composite single-string `_id` for the document stores that previously keyed `_id: ticker`
 * (`company_fundamentals`, `corporate_actions`, `earnings_calendar`). Where a single-string key is
 * unavoidable the platform uses `${symbol}:${market}` (the same rule as the Redis cache keys) — so
 * the stored key carries the bare symbol, never the concatenated T212 form. The doc ALSO carries
 * `symbol`/`market` as separate queryable fields; this is just the primary key.
 */
export function idOf(id: TickerIdentity): string {
  return `${id.symbol}:${id.market}`;
}

/** Convenience: the composite `_id` for a T212 ticker, or `null` when it doesn't parse (fail-soft). */
export function tryIdOf(ticker: string): string | null {
  const id = tryIdentityOf(ticker);
  return id === null ? null : idOf(id);
}

/**
 * Instrument currency for a stored `market` value, routed through the adapter's single
 * market→currency map (US→USD, LSE→GBP). An unrecognised market falls back to the account base (GBP).
 */
export function currencyOfMarket(market: string): Currency {
  if (market === 'US' || market === 'LSE') return adapter.currencyOf({ symbol: 'x', market: market as Market });
  return 'GBP';
}
