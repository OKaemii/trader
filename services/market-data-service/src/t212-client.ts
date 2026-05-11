import type { OHLCVBar } from '@trader/shared-types';

const T212_BASE = 'https://live.trading212.com/api/v0';

export async function fetchT212Prices(tickers: string[]): Promise<OHLCVBar[]> {
  const headers = { Authorization: process.env.T212_API_KEY ?? '' };
  const now = Date.now();

  const results = await Promise.allSettled(
    tickers.map(async (ticker) => {
      const res = await fetch(
        `${T212_BASE}/equity/history/orders?ticker=${ticker}&limit=1`,
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
  const headers = { Authorization: process.env.T212_API_KEY ?? '' };
  const res = await fetch(`${T212_BASE}/equity/metadata/instruments`, { headers });
  if (!res.ok) throw new Error(`T212 instruments: ${res.status}`);
  return res.json();
}
