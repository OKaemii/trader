// TwelveDataProvider — MarketDataProvider backed by TwelveData (https://twelvedata.com).
// Replaces YahooProvider as the platform's market-data source. See twelvedata-client.ts
// for the free-tier credit budget and why this provider advertises only a 24h poll
// cadence. Everything downstream (poll loop, admin backfill, universe ranking) consumes
// the MarketDataProvider interface and is unaffected by the swap — the only wiring change
// is the constructor selected in market-data-service/index.ts.
//
// Granularity policy matches the rest of the platform: history is always pulled at 5m and
// stored tagged `interval: '5m'`; coarser intervals are derived on read via aggregateBars.

import type { OHLCVBar, Currency, PollIntervalKey } from '@trader/shared-types';
import type { MarketDataProvider } from './market-data-provider.ts';
import { TwelveDataClient, type TwelveDataClientOptions } from './twelvedata-client.ts';
import { log } from '../../../../logger.ts';

// A single /time_series request is bounded by outputsize=5000 ≈ 64 trading days of 5m
// bars. We advertise 60 days so each backfill stays one request and so the window matches
// what the service already assumes (Yahoo's 60d cap). The free tier serves history well
// beyond this; raise it (and chunk fetchHistory across requests) if you upgrade the plan.
const FIVE_MIN_LOOKBACK_DAYS = 60;

export class TwelveDataProvider implements MarketDataProvider {
  readonly name = 'twelvedata';
  readonly maxLookbackMs = FIVE_MIN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  // Free tier = 8 credits/min, 800/day, 1 credit per symbol. A full poll of a ~200-ticker
  // universe is ~200 credits / ~25 min, so only a once-daily cadence is affordable. Intraday
  // cadences are deliberately omitted; a paid plan widens both this list and the
  // creditsPerMinute / dailyCreditLimit knobs (TwelveDataClientOptions).
  readonly allowedPollIntervals: readonly PollIntervalKey[] = ['24h'];

  private readonly client: TwelveDataClient;

  // fxToGBP is injected so the provider stays free of @trader/shared-fx as a dependency
  // direction (same arrangement as YahooProvider). Only fetchLiquidity needs it; bars are
  // tagged with their native currency and FX-converted by downstream NAV/sizing code.
  constructor(
    opts: TwelveDataClientOptions,
    private readonly fxToGBP?: (amount: number, currency: Currency) => Promise<number>,
  ) {
    this.client = new TwelveDataClient(opts);
  }

  /** Credits spent in the current UTC day — surfaced for /health + diagnostics. */
  get creditsUsedToday(): number { return this.client.creditsUsedToday; }
  get dailyCreditLimit(): number { return this.client.dailyCreditLimit; }

  // Legacy one-off lookup (not used by the windowed poll loop). Returns the most recent
  // daily bar per ticker, stamped at `fetchTime` to mirror YahooProvider.fetchLatest.
  async fetchLatest(tickers: string[], fetchTime: number = Date.now()): Promise<OHLCVBar[]> {
    const out: OHLCVBar[] = [];
    for (const ticker of tickers) {
      const bars = await this.client.fetchDailyBars(ticker, 1);
      const latest = bars[bars.length - 1];
      if (latest) out.push({ ...latest, observation_ts: fetchTime, timestamp: fetchTime });
    }
    return out;
  }

  // Windowed 5m fetch used by the live-poll loop. Sequential by design: the client's credit
  // limiter serialises requests to ~8/min anyway, so parallel dispatch would only pile up
  // pending promises with no throughput gain. Unresolvable/blacklisted tickers are skipped.
  async fetchRecent(tickers: string[], windowHours: number = 24): Promise<OHLCVBar[]> {
    const now = Date.now();
    const since = now - windowHours * 60 * 60_000;
    const out: OHLCVBar[] = [];
    for (const ticker of tickers) {
      try {
        out.push(...await this.client.fetch5mBars(ticker, since, now));
      } catch (err) {
        log.warn(`[twelvedata] fetchRecent entry failed for ${ticker}:`, err instanceof Error ? err.message : err);
      }
    }
    return out;
  }

  async fetchHistory(ticker: string, startTs: number, endTs: number = Date.now()): Promise<OHLCVBar[]> {
    if (endTs <= startTs) return [];
    // Truncate to the 5m lookback cap with the same 60s noise band as YahooProvider so a
    // "full 60-day backfill" whose startTs lands a few ms past the cap is neither narrowed
    // to a degenerate window nor spuriously warned.
    const earliest = Date.now() - this.maxLookbackMs;
    const TRUNCATION_LOG_THRESHOLD_MS = 60_000;
    let effectiveStart = startTs;
    if (startTs < earliest - TRUNCATION_LOG_THRESHOLD_MS) {
      log.warn(`[twelvedata] history truncated for ${ticker}: requested ${new Date(startTs).toISOString()} but 5m cap is ${FIVE_MIN_LOOKBACK_DAYS}d (=${new Date(earliest).toISOString()})`);
      effectiveStart = earliest;
    } else if (startTs < earliest) {
      effectiveStart = earliest;
    }
    return this.client.fetch5mBars(ticker, effectiveStart, endTs);
  }

  // 5-day average dollar volume per ticker, denominated in GBP. One daily request per
  // ticker. When no FX converter is injected (tests / admin stubs), ranks within a currency
  // are correct but cross-currency mixing is off by an FX factor — acceptable for tests.
  async fetchLiquidity(tickers: string[]): Promise<Record<string, number>> {
    const fx = this.fxToGBP ?? (async (amount: number) => amount);
    const out: Record<string, number> = {};
    for (const ticker of tickers) {
      try {
        const bars = await this.client.fetchDailyBars(ticker, 5);
        if (bars.length === 0) { out[ticker] = 0; continue; }
        let sumNative = 0;
        let count = 0;
        for (const b of bars) {
          if (b.close > 0 && b.volume > 0) { sumNative += b.close * b.volume; count++; }
        }
        if (count === 0) { out[ticker] = 0; continue; }
        const advNative = sumNative / count;
        const currency = bars[bars.length - 1]?.currency;
        out[ticker] = currency ? await fx(advNative, currency) : advNative;
      } catch (err) {
        log.warn(`[twelvedata] fetchLiquidity entry failed for ${ticker}:`, err instanceof Error ? err.message : err);
        out[ticker] = 0;
      }
    }
    return out;
  }
}
