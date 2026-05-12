import type { OHLCVBar } from '@trader/shared-types';

function t212Base(): string {
  return process.env.TRADING_MODE === 'live'
    ? 'https://live.trading212.com/api/v0'
    : 'https://demo.trading212.com/api/v0';
}

function t212Auth(): string {
  const isLive = process.env.TRADING_MODE === 'live';
  const key    = isLive ? (process.env.T212_API_KEY    ?? '') : (process.env.T212_API_KEY_DEMO    ?? '');
  const keyId  = isLive ? (process.env.T212_API_KEY_ID ?? '') : (process.env.T212_API_KEY_ID_DEMO ?? '');
  return 'Basic ' + Buffer.from(`${keyId}:${key}`).toString('base64');
}

export async function fetchT212Prices(tickers: string[]): Promise<OHLCVBar[]> {
  const headers = { Authorization: t212Auth() };
  const now = Date.now();

  const results = await Promise.allSettled(
    tickers.map(async (ticker) => {
      const res = await fetch(
        `${t212Base()}/equity/history/orders?ticker=${ticker}&limit=1`,
        { headers },
      );
      if (!res.ok) throw new Error(`T212 ${ticker}: ${res.status}`);
      const data = await res.json();
      return mapT212ToBar(ticker, data, now);
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<OHLCVBar> => r.status === 'fulfilled')
    .map((r) => r.value);
}

function mapT212ToBar(ticker: string, data: unknown, ts: number): OHLCVBar {
  // T212 returns current quote; OHLCV approximation for MVP
  const quote = (data as { items: Array<{ fillPrice: number }> }).items?.[0];
  const price = quote?.fillPrice ?? 0;
  return { ticker, timestamp: ts, open: price, high: price, low: price, close: price, volume: 0 };
}

export async function fetchT212Instruments(): Promise<Array<{ ticker: string; name: string; sector?: string }>> {
  const headers = { Authorization: t212Auth() };
  // Retry with exponential backoff — 429s accumulate when pods restart frequently during debugging.
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${t212Base()}/equity/metadata/instruments`, { headers });
    if (res.ok) return res.json();
    if (res.status === 429) {
      const wait = 30_000 * 2 ** attempt;
      console.warn(`[t212] instruments rate-limited, retrying in ${wait / 1000}s`);
      await Bun.sleep(wait);
      continue;
    }
    throw new Error(`T212 instruments: ${res.status}`);
  }
  throw new Error('T212 instruments: exceeded retry limit (429)');
}
