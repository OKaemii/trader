// trading-service — the Mongo storage-boundary ticker↔identity bridge (Thread A, Task 16a).
//
// The `orders` documents are keyed on the BARE identity — `symbol` + `market` — never the
// concatenated Trading212 `ticker`. The in-memory Order entity still carries `.ticker` (the broker
// boundary — placing the order, parsing fills — migrates in Task 17, and the FillsPoller still keys
// its cross-service `openBuys(ticker)` call on the T212 string). So this module is the single place
// that splits a T212 ticker into a TickerIdentity before an `orders` Mongo touch, and re-joins it on
// read so the reconstructed Order.ticker is byte-identical to what was saved.
//
// `Trading212TickerAdapter.fromT212` is the platform's single suffix parser; it throws on a form
// that is neither a US (`_US_EQ`) nor an LSE (`l_EQ`) equity. An order is always for a tradable
// US/LSE name, so on the WRITE path a parse failure is a real bug worth surfacing; the read/query
// paths degrade fail-soft (a corrupt row falls back to its stored ticker / matches nothing).

import { Trading212TickerAdapter, type TickerIdentity } from '@trader/ticker-identity';

const adapter = new Trading212TickerAdapter();

/** Split a T212 ticker into its bare `(symbol, market)` identity. Throws on a non-US/LSE form. */
export function identityOf(ticker: string): TickerIdentity {
  return adapter.fromT212(ticker);
}

/**
 * Split a T212 ticker fail-soft: `(symbol, market)` or `null` when it isn't a recognised US/LSE
 * equity. Query call sites use this so an un-routable name degrades to no-match, not a throw.
 */
export function tryIdentityOf(ticker: string): TickerIdentity | null {
  try { return adapter.fromT212(ticker); } catch { return null; }
}

/** Re-derive the T212 ticker from a `(symbol, market)` pair — the inverse of {@link identityOf}. */
export function tickerOf(symbol: string, market: string): string {
  return adapter.toT212({ symbol, market: market as TickerIdentity['market'] });
}
