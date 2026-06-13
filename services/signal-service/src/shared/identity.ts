// signal-service — the Mongo storage-boundary ticker↔identity bridge (Thread A, Task 16a).
//
// The `signals` (and `held_set_snapshots`) documents are keyed on the BARE identity — `symbol` +
// `market` — never the concatenated Trading212 `ticker`. The in-memory domain (TradeSignal.ticker,
// the internal HTTP routes, the cross-service contracts) still works in the T212 ticker during the
// Thread A transition: this module is the single place that splits a T212 ticker into a
// TickerIdentity before any Mongo touch, and re-joins it on the way out so a read reconstructs the
// same `ticker` the writer started with (the broker boundary itself migrates in Task 17).
//
// `Trading212TickerAdapter.fromT212` is the platform's single suffix parser; it throws on a form
// that is neither a US (`_US_EQ`) nor an LSE (`l_EQ`) equity. Two consumption styles, mirroring the
// shared-bars bridge:
//   - On the WRITE side (toSignalDoc) a ticker is always a freshly-emitted tradable name, so a parse
//     failure there is a real bug worth surfacing.
//   - On QUERY filters (findOpenBuysByTicker / findByTicker) and on READ reconstruction the split is
//     fail-soft — a stale/renamed/delisted ticker persisted in an old doc must degrade (no match /
//     fall back to the stored ticker), never throw the whole batch, preserving the pre-Thread-A
//     behaviour where an unknown ticker simply produced no match.

import { Trading212TickerAdapter, type TickerIdentity } from '@trader/ticker-identity';

const adapter = new Trading212TickerAdapter();

/** Split a T212 ticker into its bare `(symbol, market)` identity. Throws on a non-US/LSE form. */
export function identityOf(ticker: string): TickerIdentity {
  return adapter.fromT212(ticker);
}

/**
 * Split a T212 ticker fail-soft: returns `(symbol, market)` or `null` when the ticker is not a
 * recognised US/LSE equity. Query/read call sites use this so a single un-routable name degrades
 * to no-match rather than throwing.
 */
export function tryIdentityOf(ticker: string): TickerIdentity | null {
  try { return adapter.fromT212(ticker); } catch { return null; }
}

/** Re-derive the T212 ticker from a `(symbol, market)` pair — the inverse of {@link identityOf}. */
export function tickerOf(symbol: string, market: string): string {
  return adapter.toT212({ symbol, market: market as TickerIdentity['market'] });
}
