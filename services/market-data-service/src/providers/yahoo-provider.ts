// YahooProvider — MarketDataProvider implementation backed by Yahoo Finance's free
// /v8/finance/chart endpoint. Wraps the existing yahoo-client.ts module (which holds
// the symbol mapping, blacklist, and batched fetch logic) plus a new history fetch.
//
// Granularity policy (see HISTORY_GRANULARITY constant):
//   We always pull 5m for history. Yahoo caps 5m at ~60 days of lookback regardless
//   of windowing — chunking won't extend it. fetchHistory truncates anything older
//   and emits a single warning. A future provider with a deeper 5m cap (Polygon, etc.)
//   advertises its real maxLookbackMs and slots in transparently.
//
// Range chunking:
//   Single Yahoo chart request can pull ~60d of 5m data. For shorter windows we make
//   one request; for the full 60d window we still make one request. Chunking only
//   becomes useful if a future provider raises the per-request cap below its lookback
//   cap — kept as an internal helper for that case but unused today.

import type { OHLCVBar, BarInterval, PollIntervalKey } from '@trader/shared-types';
import type { MarketDataProvider } from './market-data-provider.ts';
import {
  fetchYahooPrices,
  fetchYahooLiquidity,
  toYahooSymbol,
  isBlacklisted,
} from '../yahoo-client.ts';

const FIVE_MIN_LOOKBACK_DAYS = 60;
const HISTORY_GRANULARITY: BarInterval = '5m';
// Reuse the batch knobs the existing yahoo-client uses for fetchYahooPrices — same
// upstream, same polite-throttle budget.
const YAHOO_BATCH_SIZE      = 20;
const YAHOO_BATCH_DELAY_MS  = 500;

interface YahooResponse {
  chart: {
    result: Array<{
      timestamp: number[];
      indicators: { quote: Array<{
        open:   (number | null)[];
        high:   (number | null)[];
        low:    (number | null)[];
        close:  (number | null)[];
        volume: (number | null)[];
      }> };
    }> | null;
    error: unknown;
  };
}

export class YahooProvider implements MarketDataProvider {
  readonly name = 'yahoo';
  readonly maxLookbackMs = FIVE_MIN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  // Yahoo free tier soft-throttles around ~2k req/hr. At 200-ticker scale, every poll
  // means 200 /chart calls (one per ticker), so cadences finer than 15m start brushing
  // that ceiling. We deliberately omit 10s/1m/5m here; a paid feed would add them back.
  readonly allowedPollIntervals: readonly PollIntervalKey[] = ['15m', '1h', '24h'];

  async fetchLatest(tickers: string[], _fetchTime?: number): Promise<OHLCVBar[]> {
    // fetchYahooPrices already stamps each bar with Date.now() internally. The
    // fetchTime arg on the interface is for testability — wiring it into the
    // existing module would require a larger refactor and isn't urgent.
    return fetchYahooPrices(tickers);
  }

  // fetchRecent: one Yahoo /chart?interval=5m request per ticker, batched at the same
  // BATCH_SIZE/BATCH_DELAY rhythm fetchYahooPrices uses. Each call returns ~78 5m bars
  // (a full US trading day) for ~200 req/hr at hourly cadence — well within Yahoo's
  // free-tier soft throttle.
  //
  // Trade-off baked into the windowHours default: hourly poll cadence × 24h window
  // means every cycle re-fetches the last day of bars. The (ticker, timestamp, '5m')
  // upsert in market-data-service makes the rewrite idempotent — only the ~12 new bars
  // since the prior poll actually mutate Mongo state.
  async fetchRecent(tickers: string[], windowHours: number = 24): Promise<OHLCVBar[]> {
    const since = Date.now() - windowHours * 60 * 60_000;
    const out: OHLCVBar[] = [];
    for (let i = 0; i < tickers.length; i += YAHOO_BATCH_SIZE) {
      const batch = tickers.slice(i, i + YAHOO_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((t) => this.fetchHistory(t, since)),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') out.push(...r.value);
        else console.warn('[yahoo] fetchRecent batch entry failed:', r.reason);
      }
      if (i + YAHOO_BATCH_SIZE < tickers.length) {
        await new Promise((res) => setTimeout(res, YAHOO_BATCH_DELAY_MS));
      }
    }
    return out;
  }

  async fetchLiquidity(tickers: string[]): Promise<Record<string, number>> {
    return fetchYahooLiquidity(tickers);
  }

  async fetchHistory(
    ticker: string,
    startTs: number,
    endTs: number = Date.now(),
  ): Promise<OHLCVBar[]> {
    if (endTs <= startTs) return [];

    const symbol = toYahooSymbol(ticker);
    if (isBlacklisted(symbol)) {
      console.warn(`[yahoo] history skipped — ${symbol} is blacklisted`);
      return [];
    }

    // Truncate any portion of the request older than the 5m lookback cap. We pad by
    // 60s so a "full 60-day backfill" — where the caller computes startTs = Date.now()
    // - 60d slightly before this method re-reads Date.now() — doesn't trip the
    // truncation warning AND silently narrow the request to a microsecond-wide window
    // that Yahoo returns empty for. Only log when the request is meaningfully past
    // the cap.
    const earliest = Date.now() - this.maxLookbackMs;
    const TRUNCATION_LOG_THRESHOLD_MS = 60_000;
    let effectiveStart = startTs;
    if (startTs < earliest - TRUNCATION_LOG_THRESHOLD_MS) {
      console.warn(`[yahoo] history truncated for ${symbol}: requested ${new Date(startTs).toISOString()} but 5m cap is ${FIVE_MIN_LOOKBACK_DAYS}d (=${new Date(earliest).toISOString()})`);
      effectiveStart = earliest;
    } else if (startTs < earliest) {
      // Within the noise band (caller's Date.now() vs ours): silently clamp.
      effectiveStart = earliest;
    }

    const period1 = Math.floor(effectiveStart / 1000);
    const period2 = Math.floor(endTs / 1000);
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=5m&period1=${period1}&period2=${period2}`;

    let data: YahooResponse;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = (await res.json()) as YahooResponse;
    } catch (err) {
      console.warn(`[yahoo] history fetch failed for ${symbol}:`, err instanceof Error ? err.message : err);
      return [];
    }

    const result = data.chart?.result?.[0];
    if (!result?.timestamp?.length) return [];
    const quote = result.indicators.quote?.[0];
    if (!quote) return [];

    const bars: OHLCVBar[] = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      const close = quote.close[i];
      if (close == null || close <= 0) continue;
      bars.push({
        ticker,
        timestamp: result.timestamp[i] * 1000,
        interval:  HISTORY_GRANULARITY,
        open:      quote.open[i]  ?? close,
        high:      quote.high[i]  ?? close,
        low:       quote.low[i]   ?? close,
        close,
        volume:    quote.volume[i] ?? 0,
      });
    }
    return bars;
  }
}
