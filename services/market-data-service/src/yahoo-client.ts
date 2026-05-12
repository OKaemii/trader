import type { OHLCVBar } from '@trader/shared-types';

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


// T212 internal tickers: AAPL_US_EQ, ZGYd_EQ, SHEL_UK_EQ, etc.
// Strip trailing lowercase T212 variant suffix (d = fractional, l = CFD) and map exchange.
function toYahooSymbol(t212Ticker: string): string {
  const parts = t212Ticker.split('_');
  const symbol = parts[0].replace(/[a-z]+$/, '');
  const exchange = parts.length >= 3 ? parts[1] : null;
  switch (exchange) {
    case 'UK': return `${symbol}.L`;
    case 'DE': return `${symbol}.DE`;
    case 'FR': return `${symbol}.PA`;
    case 'NL': return `${symbol}.AS`;
    case 'ES': return `${symbol}.MC`;
    case 'CA': return `${symbol}.TO`;
    default:   return symbol;
  }
}

interface YahooQuote {
  open: (number | null)[];
  high: (number | null)[];
  low:  (number | null)[];
  close: (number | null)[];
  volume: (number | null)[];
}

interface YahooResponse {
  chart: {
    result: Array<{
      timestamp: number[];
      indicators: { quote: YahooQuote[] };
    }> | null;
    error: unknown;
  };
}

const BATCH_SIZE       = 20;
const BATCH_DELAY_MS   = 500;

async function fetchOne(t212Ticker: string, fetchTime: number): Promise<OHLCVBar> {
  const symbol = toYahooSymbol(t212Ticker);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: ${res.status}`);

  const data = await res.json() as YahooResponse;
  const result = data.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(`Yahoo ${symbol}: no chart result`);

  const q = result.indicators.quote[0];
  let i = result.timestamp.length - 1;
  while (i >= 0 && (q.close[i] == null || q.close[i]! <= 0)) i--;
  if (i < 0) throw new Error(`Yahoo ${symbol}: no valid close`);

  const close  = q.close[i]!;
  const open   = q.open[i]   ?? close;
  const high   = q.high[i]   ?? close;
  const low    = q.low[i]    ?? close;
  const volume = q.volume[i] ?? 0;

  return { ticker: t212Ticker, timestamp: fetchTime, open, high, low, close, volume };
}

export async function fetchYahooPrices(t212Tickers: string[]): Promise<OHLCVBar[]> {
  const fetchTime = Date.now();
  const bars: OHLCVBar[] = [];

  for (let i = 0; i < t212Tickers.length; i += BATCH_SIZE) {
    const batch = t212Tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((t) => fetchOne(t, fetchTime)));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        bars.push(r.value);
      } else {
        console.warn('[yahoo] price fetch failed:', (r.reason as Error).message);
      }
    }
    if (i + BATCH_SIZE < t212Tickers.length) await Bun.sleep(BATCH_DELAY_MS);
  }

  return bars;
}
