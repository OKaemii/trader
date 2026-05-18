// MarketDataProvider — abstraction over an upstream source of OHLCV bars.
//
// Today: YahooProvider (free, 60-day cap on 5m granularity, batched fetch via
// /v8/finance/chart). Tomorrow: any other source (Polygon, Alpaca, broker-native)
// — implement this interface, swap the wiring in market-data-service/index.ts,
// every consumer continues to work unchanged.
//
// Provider implementations are responsible for:
//   - Symbol mapping (T212 ticker → upstream symbol)
//   - Rate-limiting / batching against the upstream's published limits
//   - Caching unresolved or blacklisted symbols to avoid wasted requests
//   - Returning OHLCVBar tagged with the appropriate `interval` field
//
// The caller (live-poll loop, admin backfill, universe manager) deals only with
// T212 tickers and millisecond timestamps — no upstream-specific concepts leak.

import type { OHLCVBar, PollIntervalKey } from '@trader/shared-types';

export interface MarketDataProvider {
  /** Human-readable provider name. Surfaced in admin diagnostics and logs. */
  readonly name: string;

  /**
   * Maximum lookback for fine-grained (5m) history, in ms. Providers that exceed
   * Yahoo's 60-day cap (e.g. paid sources) advertise their real limit here so the
   * backfill endpoint can warn callers requesting a longer window.
   */
  readonly maxLookbackMs: number;

  /**
   * Poll cadences this provider can sustain without tripping its upstream rate
   * limit at the configured universe size. Subset of PollIntervalKey. The portal
   * renders only these in the dropdown; live-config validation rejects anything
   * outside this list as defence-in-depth.
   *
   * Yahoo (free): ['15m', '1h', '24h'] — 5m and below would burn the soft throttle.
   * A paid feed could add ['10s', '1m', '5m', ...] to enable intraday strategies.
   */
  readonly allowedPollIntervals: readonly PollIntervalKey[];

  /**
   * Fetch the single most recent bar per ticker. Returns one OHLCVBar per resolvable
   * ticker (provider's discretion on the granularity — Yahoo today returns the
   * most-recent daily bar via /chart?interval=1d&range=5d). Useful for one-off lookups
   * and the legacy live-poll path; NOT used by the windowed poll loop, which calls
   * fetchRecent to amortise upstream requests across many bars.
   *
   * @param fetchTime  Unix ms to stamp on the returned bars. Provider doesn't have to
   *                   use this for live quotes; useful for deterministic testing.
   */
  fetchLatest(tickers: string[], fetchTime?: number): Promise<OHLCVBar[]>;

  /**
   * Fetch a *window* of recent 5m bars for each ticker. Used by the live-poll loop:
   * one call per polling cycle returns ~78 5m bars per resolvable ticker (a full
   * trading day at 5m granularity in a single upstream request). Successive polls
   * idempotently re-upsert overlapping bars and add only the new ones since last
   * poll. Unresolvable tickers are silently skipped — caller handles the gap via
   * gapDetector.
   *
   * Why a window instead of a single bar: at 200-ticker scale, polling every 5m for
   * a single fresh bar would burn ~2400 Yahoo requests/hour and brush against the
   * free-tier soft throttle. Polling hourly with a 1d-of-5m window costs ~200 req/hr
   * for the same end state. Providers that don't share this constraint (e.g. paid
   * feeds, broker-native) can still implement fetchRecent — it's the right shape
   * for storage-always-5m architecture regardless of upstream rate limits.
   *
   * @param tickers     T212-formatted tickers (UniverseManager's active set).
   * @param windowHours How far back to pull 5m bars. Defaults to 24h ≈ one trading
   *                    day of 5m bars per ticker. Provider clamps to its own
   *                    upstream cap.
   */
  fetchRecent(tickers: string[], windowHours?: number): Promise<OHLCVBar[]>;

  /**
   * Fetch 5m OHLCV history for a single ticker. Bars are sorted oldest-first and
   * tagged with `interval: '5m'`. If the requested window extends past maxLookbackMs,
   * the provider truncates silently and logs a warning — partial success is more
   * useful to the backfill endpoint than a hard failure.
   *
   * @param ticker   T212-formatted ticker.
   * @param startTs  Inclusive lower bound (Unix ms).
   * @param endTs    Exclusive upper bound (Unix ms). Defaults to now.
   */
  fetchHistory(ticker: string, startTs: number, endTs?: number): Promise<OHLCVBar[]>;

  /**
   * 5-day average dollar volume per ticker. Used by UniverseManager to rank curated
   * candidate pools before applying the top-N cap. Returns 0 for unresolvable tickers.
   */
  fetchLiquidity(tickers: string[]): Promise<Record<string, number>>;
}
