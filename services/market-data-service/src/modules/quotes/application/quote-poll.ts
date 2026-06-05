import type { Logger } from '@trader/core';
import type { QuoteProvider } from '../infrastructure/quote-provider.ts';
import type { QuoteWriter, QuoteRow } from '../infrastructure/quote-writer.ts';
import { type BarHL, realQuoteRow, realMidQuoteRow, syntheticFromBar } from './quote-row.ts';

// Separate poll from the bars loop (different cadence + endpoint, shared rate budget). Real quotes
// from the configured QuoteProvider when available; a synthetic high-low proxy fills gaps (off-hours,
// thin names, or a provider that returns nothing) so every active ticker has a row. Dependencies are
// injected (provider, writer, universe, latest-bar lookup) — the loop is pure orchestration,
// unit-testable via runOnce().
export interface QuotePollDeps {
  provider: QuoteProvider;
  writer: QuoteWriter;
  activeTickers: () => string[];
  latestBar: (ticker: string) => Promise<BarHL | null>;
  logger: Logger;
}

export class QuotePoll {
  private timer?: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly deps: QuotePollDeps) {}

  async runOnce(now: number = Date.now()): Promise<{ written: number; real: number; synthetic: number }> {
    const tickers = this.deps.activeTickers();
    if (tickers.length === 0) return { written: 0, real: 0, synthetic: 0 };

    let raw: Awaited<ReturnType<QuoteProvider['fetchQuotes']>> = [];
    try {
      raw = await this.deps.provider.fetchQuotes(tickers);
    } catch (err) {
      this.deps.logger.warn({ err }, '[quote-poll] provider fetch failed — falling back to synthetic for all');
    }

    const rows: QuoteRow[] = [];
    let real = 0;
    let synthetic = 0;
    const seen = new Set<string>();

    for (const q of raw) {
      seen.add(q.ticker);
      // Full bid/ask book if the feed has one; else a real last-price (paid feed); else synthetic.
      const rq = realQuoteRow(q, now) ?? realMidQuoteRow(q, now);
      if (rq) {
        rows.push(rq);
        real += 1;
      } else {
        const bar = await this.deps.latestBar(q.ticker);
        if (bar) {
          rows.push(syntheticFromBar(q.ticker, bar, now));
          synthetic += 1;
        }
      }
    }
    // Tickers Yahoo didn't return at all → synthesize.
    for (const t of tickers) {
      if (seen.has(t)) continue;
      const bar = await this.deps.latestBar(t);
      if (bar) {
        rows.push(syntheticFromBar(t, bar, now));
        synthetic += 1;
      }
    }

    const written = await this.deps.writer.writeBatch(rows);
    this.deps.logger.info({ tickers: tickers.length, real, synthetic, written }, '[quote-poll] cycle complete');
    return { written, real, synthetic };
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    void this.runOnce().catch((err) => this.deps.logger.warn({ err }, '[quote-poll] initial run failed'));
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => this.deps.logger.warn({ err }, '[quote-poll] run failed'));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
