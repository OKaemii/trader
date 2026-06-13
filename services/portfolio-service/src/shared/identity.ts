// portfolio-service — the Mongo storage-boundary ticker↔identity bridge (Thread A, Task 16a).
//
// The `positions` documents are keyed on the BARE identity — `symbol` + `market` — never the
// concatenated Trading212 `ticker`. trading-service still hands portfolio sync the T212 ticker over
// the contract (its broker boundary migrates in Task 17), so this module splits that ticker into a
// TickerIdentity before the `positions` Mongo touch, and re-joins it on read for any consumer that
// renders a ticker label.
//
// `Trading212TickerAdapter.fromT212` is the platform's single suffix parser; it throws on a form
// that is neither a US (`_US_EQ`) nor an LSE (`l_EQ`) equity. Position sync is fail-soft: a T212
// position whose ticker doesn't parse (an exotic instrument T212 reports) is skipped for that name
// rather than aborting the whole sync.

import { Trading212TickerAdapter, type TickerIdentity } from '@trader/ticker-identity';

const adapter = new Trading212TickerAdapter();

/**
 * Split a T212 ticker fail-soft: `(symbol, market)` or `null` when it isn't a recognised US/LSE
 * equity. Position sync uses this so one un-routable instrument degrades to a skipped row.
 */
export function tryIdentityOf(ticker: string): TickerIdentity | null {
  try { return adapter.fromT212(ticker); } catch { return null; }
}

/** Re-derive the T212 ticker from a `(symbol, market)` pair. */
export function tickerOf(symbol: string, market: string): string {
  return adapter.toT212({ symbol, market: market as TickerIdentity['market'] });
}
