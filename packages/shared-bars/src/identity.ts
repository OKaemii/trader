// shared-bars — the storage-boundary ticker↔identity bridge (Thread A, Task 15).
//
// Storage (the Timescale `bars`/`quotes` columns, the Redis cache keys) is keyed on the BARE
// identity — `symbol` + `market` — never the concatenated Trading212 `ticker`. Callers of the
// shared-bars public functions still hand in a T212 ticker (e.g. 'AAPL_US_EQ') during the Thread A
// transition; this module is the one place inside shared-bars that splits that ticker into a
// `TickerIdentity` before any SQL/cache touch, and re-joins it back on the way out so the returned
// `OHLCVBar.ticker` is byte-identical to what the caller passed (the deep OHLCVBar.ticker contract is
// untouched by this card — it migrates to symbol/market in the later Thread A storage cards).
//
// `Trading212TickerAdapter.fromT212` is the single suffix parser in the platform; it throws on a
// form that is neither a US (`_US_EQ`) nor an LSE (`l_EQ`) equity. In practice only tradable US/LSE
// bars are ever persisted (the poll loop partitions and skips `OTHER`), so a non-US/LSE ticker
// reaching storage is a real error worth surfacing, not a silently-dropped row.

import { Trading212TickerAdapter, type TickerIdentity } from '@trader/ticker-identity';

const adapter = new Trading212TickerAdapter();

/** Split a T212 ticker into its bare `(symbol, market)` identity. Throws on a non-US/LSE form. */
export function identityOf(ticker: string): TickerIdentity {
  return adapter.fromT212(ticker);
}

/** Re-derive the T212 ticker from a `(symbol, market)` pair — the inverse of {@link identityOf}. */
export function tickerOf(symbol: string, market: string): string {
  return adapter.toT212({ symbol, market: market as TickerIdentity['market'] });
}

/**
 * The single-string identity segment used inside a Redis cache key: `${symbol}:${market}`. Replaces
 * the bare `ticker` segment so two markets listing the same symbol never collide on one entry.
 */
export function identityKey(symbol: string, market: string): string {
  return `${symbol}:${market}`;
}
