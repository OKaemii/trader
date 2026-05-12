import type { OHLCVBar } from '@trader/shared-types';

/**
 * Trading212 ticker examples:
 *
 * AAPL_US_EQ
 * SHEL_UK_EQ
 * ZGYd_EQ
 * V6Cd1_EQ
 *
 * Notes:
 * - trailing "d" = fractional share variant
 * - trailing "l" = CFD variant
 * - many symbols require Yahoo exchange suffixes
 */

interface YahooQuote {
  open: (number | null)[];
  high: (number | null)[];
  low: (number | null)[];
  close: (number | null)[];
  volume: (number | null)[];
}

interface YahooResponse {
  chart: {
    result: Array<{
      timestamp: number[];
      indicators: {
        quote: YahooQuote[];
      };
    }> | null;
    error: unknown;
  };
}

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 500;

/**
 * Persistent symbol cache
 * Helps avoid repeated normalization work
 */
const yahooSymbolCache = new Map<string, string>();

/**
 * Yahoo Finance exchange suffix mapping
 */
const EXCHANGE_SUFFIX: Record<string, string> = {
  UK: '.L',
  DE: '.DE',
  FR: '.PA',
  NL: '.AS',
  ES: '.MC',
  CA: '.TO',

  CH: '.SW',
  IT: '.MI',
  SE: '.ST',
  NO: '.OL',
  DK: '.CO',
  FI: '.HE',
  BE: '.BR',
  AT: '.VI',

  AU: '.AX',
  JP: '.T',
  HK: '.HK',
  SG: '.SI',
};

/**
 * Remove ONLY Trading212 synthetic suffixes:
 * - d = fractional
 * - l = CFD
 *
 * Examples:
 * ZGYd  -> ZGY
 * SHELl -> SHEL
 *
 * Does NOT corrupt:
 * V6Cd1
 * WCCPl
 * etc.
 */
function normalizeBaseSymbol(raw: string): string {
  return raw.replace(/[dl]$/, '');
}

/**
 * Convert Trading212 ticker -> Yahoo ticker
 */
function toYahooSymbol(t212Ticker: string): string {
  const cached = yahooSymbolCache.get(t212Ticker);
  if (cached) return cached;

  const parts = t212Ticker.split('_');

  /**
   * Examples:
   *
   * AAPL_US_EQ
   * SGLN_UK_EQ
   * ZGYd_EQ
   * V6Cd1_EQ
   */

  const rawSymbol = parts[0];
  const exchange =
    parts.length >= 3
      ? parts[1]
      : null;

  const symbol = normalizeBaseSymbol(rawSymbol);

  const suffix =
    exchange && EXCHANGE_SUFFIX[exchange]
      ? EXCHANGE_SUFFIX[exchange]
      : '';

  const yahooSymbol = `${symbol}${suffix}`;

  yahooSymbolCache.set(t212Ticker, yahooSymbol);

  return yahooSymbol;
}

async function fetchOne(
  t212Ticker: string,
  fetchTime: number
): Promise<OHLCVBar> {
  const yahooSymbol = toYahooSymbol(t212Ticker);

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/` +
    `${encodeURIComponent(yahooSymbol)}` +
    `?interval=1d&range=5d`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(
      `Yahoo ${yahooSymbol}: HTTP ${res.status}`
    );
  }

  const data = (await res.json()) as YahooResponse;

  const result = data.chart?.result?.[0];

  if (!result?.timestamp?.length) {
    throw new Error(
      `Yahoo ${yahooSymbol}: no chart result`
    );
  }

  const quote = result.indicators.quote?.[0];

  if (!quote) {
    throw new Error(
      `Yahoo ${yahooSymbol}: missing quote data`
    );
  }

  /**
   * Walk backwards to find latest valid candle
   */
  let i = result.timestamp.length - 1;

  while (
    i >= 0 &&
    (
      quote.close[i] == null ||
      quote.close[i]! <= 0
    )
  ) {
    i--;
  }

  if (i < 0) {
    throw new Error(
      `Yahoo ${yahooSymbol}: no valid close`
    );
  }

  const close = quote.close[i]!;
  const open = quote.open[i] ?? close;
  const high = quote.high[i] ?? close;
  const low = quote.low[i] ?? close;
  const volume = quote.volume[i] ?? 0;

  return {
    ticker: t212Ticker,
    timestamp: fetchTime,
    open,
    high,
    low,
    close,
    volume,
  };
}

export async function fetchYahooPrices(
  t212Tickers: string[]
): Promise<OHLCVBar[]> {
  const fetchTime = Date.now();

  const bars: OHLCVBar[] = [];

  for (
    let i = 0;
    i < t212Tickers.length;
    i += BATCH_SIZE
  ) {
    const batch = t212Tickers.slice(
      i,
      i + BATCH_SIZE
    );

    const results = await Promise.allSettled(
      batch.map((ticker) =>
        fetchOne(ticker, fetchTime)
      )
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const t212Ticker = batch[j];
      const yahooSymbol = toYahooSymbol(t212Ticker);

      if (result.status === 'fulfilled') {
        bars.push(result.value);
      } else {
        console.warn('[yahoo] price fetch failed', {
          t212Ticker,
          yahooSymbol,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    }

    if (i + BATCH_SIZE < t212Tickers.length) {
      await Bun.sleep(BATCH_DELAY_MS);
    }
  }

  return bars;
}
