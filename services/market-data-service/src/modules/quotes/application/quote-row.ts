import type { RawQuote } from '../infrastructure/quote-provider.ts';
import type { QuoteRow } from '../infrastructure/quote-writer.ts';

// Pure builders: RawQuote → QuoteRow (real) when Yahoo returned a sane book, else null so the
// caller falls back to a synthetic estimate from the most recent bar.

export function realQuoteRow(q: RawQuote, now: number): QuoteRow | null {
  if (q.bid == null || q.ask == null || q.bid <= 0 || q.ask <= 0 || q.ask < q.bid || q.mid == null) {
    return null;
  }
  const mid = (q.bid + q.ask) / 2;
  const spread = q.ask - q.bid;
  return {
    ticker: q.ticker,
    observation_ts: q.observedAt,
    knowledge_ts: now,
    bid: q.bid,
    ask: q.ask,
    mid,
    spread,
    spread_bps: mid > 0 ? (10000 * spread) / mid : null,
    bid_size: q.bidSize,
    ask_size: q.askSize,
    market_state: q.marketState,
    source: 'yahoo',
    is_synthetic: false,
  };
}

// Synthetic high-low proxy: half-spread ≈ (high - low) / 4 (empirically ~2× the quoted spread
// for liquid names — coarse, flagged is_synthetic so the §29b filter can prefer real rows).
export interface BarHL {
  high: number;
  low: number;
  close: number;
}

export function syntheticFromBar(ticker: string, bar: BarHL, now: number): QuoteRow {
  const halfSpread = Math.max((bar.high - bar.low) / 4, 0);
  const mid = bar.close;
  const spread = 2 * halfSpread;
  return {
    ticker,
    observation_ts: now,
    knowledge_ts: now,
    bid: mid - halfSpread,
    ask: mid + halfSpread,
    mid,
    spread,
    spread_bps: mid > 0 ? (10000 * spread) / mid : null,
    bid_size: null,
    ask_size: null,
    market_state: 'CLOSED',
    source: 'synthetic',
    is_synthetic: true,
  };
}
