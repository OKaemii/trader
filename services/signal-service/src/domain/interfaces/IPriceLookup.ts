// Latest known close price for a ticker, used to:
//   - stamp entryPrice onto a new TradeSignal at emission
//   - compute live P&L for the /api/signals/progress endpoint
//
// Returns null when no bar has been ingested for the ticker yet (new universe member,
// or upstream gap). Callers must tolerate null and surface that to the UI rather than
// fabricating a zero.
export interface IPriceLookup {
  lastClose(ticker: string): Promise<number | null>;
  lastCloseMany(tickers: string[]): Promise<Record<string, number | null>>;
}
