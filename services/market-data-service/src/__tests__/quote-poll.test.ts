import { describe, it, expect } from 'vitest';
import { realQuoteRow, syntheticFromBar } from '../modules/quotes/application/quote-row.ts';
import { QuotePoll } from '../modules/quotes/application/quote-poll.ts';
import type { RawQuote } from '../modules/quotes/infrastructure/quote-provider.ts';
import type { QuoteRow } from '../modules/quotes/infrastructure/quote-writer.ts';

const NOW = 1_700_000_000_000;
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

function raw(over: Partial<RawQuote> = {}): RawQuote {
  return { ticker: 'AAPL_US_EQ', bid: 100, ask: 100.2, mid: 100.1, bidSize: 3, askSize: 2, marketState: 'REGULAR', observedAt: NOW, ...over };
}

describe('quote-row builders', () => {
  it('realQuoteRow builds from a sane book', () => {
    const r = realQuoteRow(raw(), NOW)!;
    expect(r.source).toBe('yahoo');
    expect(r.mid).toBeCloseTo(100.1, 6);
    expect(r.spread).toBeCloseTo(0.2, 6);
    expect(r.is_synthetic).toBe(false);
  });

  it('realQuoteRow returns null on missing/crossed book', () => {
    expect(realQuoteRow(raw({ bid: null }), NOW)).toBeNull();
    expect(realQuoteRow(raw({ bid: 101, ask: 100 }), NOW)).toBeNull();
    expect(realQuoteRow(raw({ ask: 0 }), NOW)).toBeNull();
  });

  it('syntheticFromBar uses high-low/4 half-spread', () => {
    const r = syntheticFromBar('X', { high: 110, low: 90, close: 100 }, NOW);
    expect(r.is_synthetic).toBe(true);
    expect(r.mid).toBe(100);
    expect(r.spread).toBe(10);          // 2 * (110-90)/4
    expect(r.bid).toBe(95);
    expect(r.ask).toBe(105);
  });
});

describe('QuotePoll.runOnce', () => {
  function makePoll(over: {
    tickers?: string[]; quotes?: RawQuote[]; bars?: Record<string, { high: number; low: number; close: number }>;
  } = {}) {
    const written: QuoteRow[] = [];
    const poll = new QuotePoll({
      provider: { name: 'fake', fetchQuotes: async () => over.quotes ?? [] },
      writer: { writeBatch: async (rows) => { written.push(...rows); return rows.length; } } as never,
      activeTickers: () => over.tickers ?? ['AAPL_US_EQ', 'MSFTl_EQ'],
      latestBar: async (t) => over.bars?.[t] ?? null,
      logger: noopLogger,
    });
    return { poll, written };
  }

  it('uses real quotes when present and synthesizes the rest', async () => {
    const { poll, written } = makePoll({
      tickers: ['AAPL_US_EQ', 'MSFTl_EQ'],
      quotes: [raw({ ticker: 'AAPL_US_EQ' })],                       // only AAPL has a quote
      bars: { MSFTl_EQ: { high: 11, low: 9, close: 10 } },           // MSFT synthesised from bar
    });
    const res = await poll.runOnce(NOW);
    expect(res.real).toBe(1);
    expect(res.synthetic).toBe(1);
    expect(written.find((r) => r.ticker === 'AAPL_US_EQ')!.source).toBe('yahoo');
    expect(written.find((r) => r.ticker === 'MSFTl_EQ')!.source).toBe('synthetic');
  });

  it('synthesizes when the quote book is empty but a bar exists', async () => {
    const { poll, written } = makePoll({
      tickers: ['AAPL_US_EQ'],
      quotes: [raw({ ticker: 'AAPL_US_EQ', bid: null, ask: null })],
      bars: { AAPL_US_EQ: { high: 101, low: 99, close: 100 } },
    });
    const res = await poll.runOnce(NOW);
    expect(res.real).toBe(0);
    expect(res.synthetic).toBe(1);
    expect(written[0]!.is_synthetic).toBe(true);
  });
});
