// Session-aware self-heal: confirms healMissingHistory does NOT flag tickers as
// gapped when their latest bar matches the most recent session close (the
// closed-window-resume case), and DOES flag tickers with bars older than that.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { healMissingHistory } from '../backfill.ts';
import type { MarketDataProvider } from '../providers/market-data-provider.ts';

const FRIDAY_CLOSE_MS = Date.parse('2026-05-15T20:00:00Z');   // NYSE Fri 16:00 EDT = 20:00 UTC
const THU_CLOSE_MS    = Date.parse('2026-05-14T20:00:00Z');
const NOW_MONDAY      = Date.parse('2026-05-18T13:30:00Z');   // Mon NYSE open

interface BarDoc { ticker: string; timestamp: Date; interval: string }

class StubMongo {
  ohlcv: BarDoc[] = [];
  badTicks: any[] = [];
  collection(name: string) {
    if (name === 'ohlcv_bars') {
      return {
        aggregate: (_pipeline: any[]) => ({
          toArray: async () => {
            const byTicker = new Map<string, number>();
            for (const b of this.ohlcv) {
              if (b.interval !== '5m') continue;
              const cur = byTicker.get(b.ticker);
              const t = b.timestamp.getTime();
              if (cur === undefined || t > cur) byTicker.set(b.ticker, t);
            }
            return [...byTicker.entries()].map(([_id, ms]) => ({ _id, latest: new Date(ms) }));
          },
        }),
        insertOne: async (doc: any) => { this.badTicks.push(doc); },
      };
    }
    if (name === 'bad_ticks') {
      return { insertOne: async (doc: any) => { this.badTicks.push(doc); } };
    }
    return {} as any;
  }
}

class StubProvider implements MarketDataProvider {
  readonly name = 'stub';
  readonly maxLookbackMs = 60 * 24 * 3600_000;
  readonly allowedPollIntervals = ['1h' as const];
  calls: Array<{ ticker: string; startTs: number }> = [];
  async fetchLatest() { return []; }
  async fetchRecent() { return []; }
  async fetchHistory(ticker: string, startTs: number) {
    this.calls.push({ ticker, startTs });
    return [];   // no new bars (the closed-window-resume case Yahoo returns empty for)
  }
  async fetchLiquidity() { return {}; }
}

const stubRedis = {} as any;

describe('healMissingHistory — session-aware threshold', () => {
  let db: StubMongo;
  let provider: StubProvider;

  beforeEach(() => {
    db = new StubMongo();
    provider = new StubProvider();
  });

  it('does NOT flag tickers whose latest bar IS Friday close (Monday resume)', async () => {
    // 150 US tickers, each with latest bar = Friday close. expectedLatestMs = Friday
    // close. No ticker is older than that → 0 heals → 0 fetchHistory calls.
    const tickers = Array.from({ length: 150 }, (_, i) => `T${i}_US_EQ`);
    for (const t of tickers) db.ohlcv.push({ ticker: t, timestamp: new Date(FRIDAY_CLOSE_MS), interval: '5m' });
    const result = await healMissingHistory(db as any, stubRedis, provider, tickers, { expectedLatestMs: FRIDAY_CLOSE_MS });
    expect(result.healed).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('DOES flag tickers whose latest bar is older than expectedLatestMs', async () => {
    // One ticker stuck at Thursday close (Yahoo glitch / trading halt). Others fine.
    const tickers = ['AAPL_US_EQ', 'MSFT_US_EQ'];
    db.ohlcv.push({ ticker: 'AAPL_US_EQ', timestamp: new Date(THU_CLOSE_MS),    interval: '5m' });
    db.ohlcv.push({ ticker: 'MSFT_US_EQ', timestamp: new Date(FRIDAY_CLOSE_MS), interval: '5m' });
    const result = await healMissingHistory(db as any, stubRedis, provider, tickers, { expectedLatestMs: FRIDAY_CLOSE_MS });
    expect(result.healed).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].ticker).toBe('AAPL_US_EQ');
  });

  it('60s grace covers Yahoo late-print: latest = expectedLatest - 30s is NOT flagged', async () => {
    const tickers = ['AAPL_US_EQ'];
    db.ohlcv.push({ ticker: 'AAPL_US_EQ', timestamp: new Date(FRIDAY_CLOSE_MS - 30_000), interval: '5m' });
    const result = await healMissingHistory(db as any, stubRedis, provider, tickers, { expectedLatestMs: FRIDAY_CLOSE_MS });
    expect(result.healed).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('latest = expectedLatest - 5min IS flagged (real gap)', async () => {
    const tickers = ['AAPL_US_EQ'];
    db.ohlcv.push({ ticker: 'AAPL_US_EQ', timestamp: new Date(FRIDAY_CLOSE_MS - 5 * 60_000), interval: '5m' });
    const result = await healMissingHistory(db as any, stubRedis, provider, tickers, { expectedLatestMs: FRIDAY_CLOSE_MS });
    expect(result.healed).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });

  it('falls back to flat 24h threshold when expectedLatestMs is omitted', async () => {
    // Without an expectedLatestMs, ANY ticker with latest bar > 24h old gets flagged.
    // Monday morning latest-Friday-close is ~64h old → would be flagged.
    const tickers = ['AAPL_US_EQ'];
    db.ohlcv.push({ ticker: 'AAPL_US_EQ', timestamp: new Date(FRIDAY_CLOSE_MS), interval: '5m' });
    const origDateNow = Date.now;
    Date.now = () => NOW_MONDAY;
    try {
      const result = await healMissingHistory(db as any, stubRedis, provider, tickers);
      expect(result.healed).toBe(1);   // flagged via flat threshold
    } finally {
      Date.now = origDateNow;
    }
  });

  it('empty ticker list short-circuits to 0/0/0', async () => {
    const result = await healMissingHistory(db as any, stubRedis, provider, [], { expectedLatestMs: FRIDAY_CLOSE_MS });
    expect(result).toEqual({ healed: 0, barsAdded: 0, unrecoverable: 0 });
  });
});
