// Latest known close price for a ticker, used to:
//   - stamp entryPrice onto a new TradeSignal at emission
//   - compute live P&L for the /api/signals/progress endpoint
//
// Returns null when no bar has been ingested for the ticker yet (new universe member,
// or upstream gap). Callers must tolerate null and surface that to the UI rather than
// fabricating a zero.
//
// Bi-temporal lookups: pass `asOf` (UTC ms knowledge-time cutoff) to read the close
// as known at that wall-clock instant. Omitting it returns the latest unsuperseded
// revision — the default "as of now" behaviour. See
// agent-docs/plans/point-in-time-bar-history.md.
export interface IPriceLookup {
  lastClose(ticker: string, asOf?: number): Promise<number | null>;
  lastCloseMany(tickers: string[], asOf?: number): Promise<Record<string, number | null>>;
}
