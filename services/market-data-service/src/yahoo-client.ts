import type { OHLCVBar, BarInterval, Currency } from '@trader/shared-types';

interface YahooQuote {
  open: (number | null)[];
  high: (number | null)[];
  low: (number | null)[];
  close: (number | null)[];
  volume: (number | null)[];
}

// Yahoo's response carries metadata we need for currency tagging. We model only the
// bits we actually consume; missing fields fall through to a conservative default.
interface YahooMeta {
  currency?: string;     // 'GBP' | 'GBp' | 'GBX' | 'USD' | …
  exchangeName?: string;
}

interface YahooResponse {
  chart: {
    result: Array<{
      meta?: YahooMeta;
      timestamp: number[];
      indicators: {
        quote: YahooQuote[];
      };
    }> | null;
    error: unknown;
  };
}

// Pence ('GBp' on Yahoo, sometimes 'GBX' on other feeds) is killed at the boundary:
// we divide every price field by 100 and persist the bar as GBP. After this point in
// the system, currency is strictly 'GBP' or 'USD' — pence does not exist.
//
// Returns:
//   - normalised currency (always 'GBP' / 'USD' / null)
//   - scale factor to multiply prices by (1.0 for GBP/USD, 0.01 for pence)
export function normaliseYahooCurrency(raw: string | undefined): {
  currency: Currency | null;
  priceScale: number;
} {
  if (!raw) return { currency: null, priceScale: 1 };
  // Pence FIRST (case-sensitive): Yahoo's 'GBp' uppercases to 'GBP' and would otherwise
  // be misclassified as already-pounds. The two flavours we've seen are 'GBp' (Yahoo)
  // and 'GBX' (alternate market data vendors); both mean "divide by 100".
  if (raw === 'GBp' || raw === 'GBX' || raw === 'gbx') return { currency: 'GBP', priceScale: 0.01 };
  const c = raw.toUpperCase();
  if (c === 'GBP') return { currency: 'GBP', priceScale: 1 };
  if (c === 'USD') return { currency: 'USD', priceScale: 1 };
  return { currency: null, priceScale: 1 };
}

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 500;

/**
 * Exchange suffix mapping
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
 * Heuristic exchange mappings for symbols
 * that arrive without exchange metadata.
 */
const HEURISTIC_SUFFIXES: Record<string, string> = {
  SGLN: '.L',
  VFEM: '.L',
  IUKD: '.L',
  XUSE: '.L',
  SRSA: '.L',
  SSLN: '.L',
  SUPR: '.L',
  GLINT: '.L',

  SXR1: '.DE',
  XDN0: '.DE',
  DBXH: '.DE',
};

/**
 * Legacy-rename overrides. T212's catalog keeps the pre-rebrand symbol; Yahoo only
 * recognises the post-rebrand one. Keyed by the normalised symbol after
 * `normalizeBaseSymbol` strips T212 synthetic suffixes — so `FB_US_EQ` and the bare
 * `FB` both resolve to `META` on Yahoo.
 */
const SYMBOL_RENAMES: Record<string, string> = {
  FB: 'META',
}

/**
 * Symbols known to be unsupported by Yahoo.
 * Prevents repeated wasted requests.
 */
const UNSUPPORTED_SYMBOLS = new Set<string>();

/**
 * Persistent ticker cache
 */
const yahooSymbolCache = new Map<string, string>();

/**
 * Retry suffixes for unresolved European ETFs
 */
const FALLBACK_SUFFIXES = [
  '.L',
  '.DE',
  '.PA',
  '.AS',
  '.MI',
];

/**
 * Remove ONLY Trading212 synthetic suffixes:
 * d = fractional
 * l = CFD
 */
function normalizeBaseSymbol(raw: string): string {
  return raw.replace(/[dl]$/, '');
}

function parseT212Ticker(t212Ticker: string): {
  rawSymbol: string;
  symbol: string;
  exchange: string | null;
} {
  const parts = t212Ticker.split('_');

  const rawSymbol = parts[0];
  const symbol = normalizeBaseSymbol(rawSymbol);

  // Three-part tickers carry an explicit exchange (e.g. `AAPL_US_EQ`).
  // Two-part tickers ending in `l_EQ` are T212's London convention (e.g. `HSBAl_EQ`,
  // `BARCl_EQ`) — the lowercase `l` on the symbol is the LSE marker, not the CFD
  // synthetic that `normalizeBaseSymbol` strips for US instruments. Without tagging
  // these as 'UK' we'd drop the `.L` Yahoo suffix and 404 every FTSE constituent.
  let exchange: string | null = null;
  if (parts.length >= 3) {
    exchange = parts[1];
  } else if (parts.length === 2 && parts[1] === 'EQ' && /l$/.test(rawSymbol)) {
    exchange = 'UK';
  }

  return {
    rawSymbol,
    symbol,
    exchange,
  };
}

export function isBlacklisted(yahooSymbol: string): boolean {
  return UNSUPPORTED_SYMBOLS.has(yahooSymbol);
}

export function toYahooSymbol(t212Ticker: string): string {
  const cached = yahooSymbolCache.get(t212Ticker);

  if (cached) return cached;

  const { symbol: rawSymbol, exchange } =
    parseT212Ticker(t212Ticker);

  // Apply legacy renames before suffix selection so e.g. Meta still gets the .L
  // heuristic correctly if it were ever cross-listed under a renamed base.
  const symbol = SYMBOL_RENAMES[rawSymbol] ?? rawSymbol;

  const suffix =
    exchange && EXCHANGE_SUFFIX[exchange]
      ? EXCHANGE_SUFFIX[exchange]
      : HEURISTIC_SUFFIXES[symbol] ?? '';

  const yahooSymbol = `${symbol}${suffix}`;

  yahooSymbolCache.set(t212Ticker, yahooSymbol);

  return yahooSymbol;
}

async function fetchYahooChart(
  yahooSymbol: string
): Promise<YahooResponse> {
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

  return (await res.json()) as YahooResponse;
}

function extractOHLCV(
  ticker: string,
  fetchTime: number,
  data: YahooResponse
): OHLCVBar {
  const result = data.chart?.result?.[0];

  if (!result?.timestamp?.length) {
    throw new Error(
      `Yahoo ${ticker}: no chart result`
    );
  }

  const quote = result.indicators.quote?.[0];

  if (!quote) {
    throw new Error(
      `Yahoo ${ticker}: missing quote data`
    );
  }

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
      `Yahoo ${ticker}: no valid close`
    );
  }

  const rawClose = quote.close[i]!;
  const rawOpen = quote.open[i] ?? rawClose;
  const rawHigh = quote.high[i] ?? rawClose;
  const rawLow = quote.low[i] ?? rawClose;
  const volume = quote.volume[i] ?? 0;

  // Currency normalisation + pence kill-switch. LSE listings frequently quote in GBp
  // (pence); after this scale-down they're indistinguishable from GBP-quoted assets
  // downstream — including in the Mongo `ohlcv_bars` rows.
  const { currency, priceScale } = normaliseYahooCurrency(result.meta?.currency);
  const close = rawClose * priceScale;
  const open  = rawOpen  * priceScale;
  const high  = rawHigh  * priceScale;
  const low   = rawLow   * priceScale;

  return {
    ticker,
    timestamp: fetchTime,
    ...(currency ? { currency } : {}),
    open,
    high,
    low,
    close,
    volume,
  };
}

async function fetchWithFallbacks(
  t212Ticker: string,
  fetchTime: number
): Promise<OHLCVBar> {
  const primaryYahooSymbol =
    toYahooSymbol(t212Ticker);

  if (
    UNSUPPORTED_SYMBOLS.has(
      primaryYahooSymbol
    )
  ) {
    throw new Error(
      `Yahoo ${primaryYahooSymbol}: blacklisted`
    );
  }

  const attempted = new Set<string>();

  const candidates: string[] = [];

  candidates.push(primaryYahooSymbol);

  const { symbol, exchange } =
    parseT212Ticker(t212Ticker);

  /**
   * If no explicit exchange,
   * try fallback European exchanges.
   */
  if (!exchange) {
    for (const suffix of FALLBACK_SUFFIXES) {
      candidates.push(`${symbol}${suffix}`);
    }
  }

  for (const yahooSymbol of candidates) {
    if (attempted.has(yahooSymbol)) {
      continue;
    }

    attempted.add(yahooSymbol);

    try {
      const data =
        await fetchYahooChart(yahooSymbol);

      /**
       * Cache successful resolution
       */
      yahooSymbolCache.set(
        t212Ticker,
        yahooSymbol
      );

      return extractOHLCV(
        t212Ticker,
        fetchTime,
        data
      );
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : String(err);

      /**
       * Continue trying fallbacks
       */
      if (
        message.includes('404') ||
        message.includes('no chart result')
      ) {
        continue;
      }

      throw err;
    }
  }

  /**
   * Blacklist permanently unsupported symbols
   */
  UNSUPPORTED_SYMBOLS.add(
    primaryYahooSymbol
  );

  throw new Error(
    `Yahoo ${primaryYahooSymbol}: unresolved`
  );
}

/**
 * Compute the 5-day average daily volume per T212 ticker, denominated in BASE_CURRENCY
 * (GBP). Used by UniverseManager to rank curated candidate pools (S&P 100 + FTSE 100)
 * by liquidity before applying the top-N cap.
 *
 * FX-correctness:
 *   - LSE pence quotes are scaled to GBP at the boundary via normaliseYahooCurrency.
 *   - USD price × volume (USD-denominated) is converted to GBP via the supplied fxToGBP.
 *   - Tickers with unknown currency (no Yahoo meta) default to whatever face value
 *     they had — this is rare and only affects pre-existing oddballs; they rank as if
 *     in base currency, which can over- or under-rank by a single FX factor.
 *
 * fxToGBP is injected to keep this module independent of @trader/shared-fx (and to
 * make the test path mockable). Caller passes (amount, currency) → GBP amount.
 */
export async function fetchYahooLiquidity(
  t212Tickers: string[],
  fxToGBP: (amount: number, currency: Currency) => Promise<number>,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < t212Tickers.length; i += BATCH_SIZE) {
    const batch = t212Tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (ticker) => {
        const yahooSymbol = toYahooSymbol(ticker);
        if (UNSUPPORTED_SYMBOLS.has(yahooSymbol)) {
          return { ticker, adv: 0 };
        }
        const chart = await fetchYahooChart(yahooSymbol);
        const result = chart.chart?.result?.[0];
        const quote = result?.indicators?.quote?.[0];
        if (!result || !quote) return { ticker, adv: 0 };
        const { currency, priceScale } = normaliseYahooCurrency(result.meta?.currency);

        let sumNative = 0;
        let count = 0;
        for (let k = 0; k < result.timestamp.length; k++) {
          const c = quote.close[k];
          const v = quote.volume[k];
          if (c != null && c > 0 && v != null && v > 0) {
            // Pence-normalised price × native-share count = native-currency notional.
            sumNative += (c * priceScale) * v;
            count++;
          }
        }
        if (count === 0) return { ticker, adv: 0 };
        const advNative = sumNative / count;

        // Convert to GBP base. If we couldn't identify a currency (legacy / weird
        // listing), pass through as-is — the alternative (assuming USD or GBP) would
        // mis-rank by a constant factor.
        const advGBP = currency
          ? await fxToGBP(advNative, currency)
          : advNative;
        return { ticker, adv: advGBP };
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') out[r.value.ticker] = r.value.adv;
    }
    if (i + BATCH_SIZE < t212Tickers.length) {
      await new Promise((res) => setTimeout(res, BATCH_DELAY_MS));
    }
  }
  return out;
}

export async function fetchYahooPrices(
  t212Tickers: string[]
): Promise<OHLCVBar[]> {
  const fetchTime = Date.now();

  const bars: OHLCVBar[] = [];

  let failures = 0;

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
        fetchWithFallbacks(
          ticker,
          fetchTime
        )
      )
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const t212Ticker = batch[j];

      if (result.status === 'fulfilled') {
        bars.push(result.value);
      } else {
        failures++;

        console.warn(
          '[yahoo] price fetch failed',
          {
            t212Ticker,
            yahooSymbol:
              toYahooSymbol(t212Ticker),
            error:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          }
        );
      }
    }

    if (i + BATCH_SIZE < t212Tickers.length) {
      await Bun.sleep(BATCH_DELAY_MS);
    }
  }

  const coverage =
    bars.length / t212Tickers.length;

  /**
   * Only fail hard if core coverage collapses.
   */
  if (coverage < 0.35) {
    console.error(
      `[market-data] critical coverage failure (${Math.round(
        coverage * 100
      )}%)`
    );
  } else {
    console.info(
      `[market-data] coverage ${Math.round(
        coverage * 100
      )}% (${bars.length}/${t212Tickers.length})`
    );
  }

  return bars;
}
