// FxClient — single source of truth for currency conversion across the platform.
//
// What it does:
//   - usdGbpRate(): GBP per 1 USD, cached in Redis for 1h.
//   - toGBP(money): convert any Money to a GBP scalar.
//
// Resilience: on Yahoo failure we serve from a separate `lastGood` Redis key with no
// TTL (until 24h max). When even that's expired, toGBP throws — callers (RiskEngine,
// PortfolioConstructor) decide whether to halt trading or proceed without confidence.
//
// Sanity bounds: we reject any rate outside [0.5, 1.5] GBP/USD. Real GBP/USD spent the
// last decade in [0.7, 0.85]; bounds give 2x slack. A rate outside that window is
// almost certainly a Yahoo data error or a transposed rate (USD/GBP vs GBP/USD).

import type { RedisClientType } from 'redis';
import { type Money, type Currency, BASE_CURRENCY } from '@trader/shared-types';

export interface FxRateProvider {
  fetchUsdGbpRate(): Promise<number>;
}

export interface FxClientOpts {
  ttlSec?:           number;     // hot-cache TTL (default 3600 = 1h)
  staleFallbackSec?: number;     // max age of lastGood we'll accept (default 86400 = 24h)
  minRate?:          number;     // sanity floor on GBP/USD (default 0.5)
  maxRate?:          number;     // sanity ceiling (default 1.5)
  now?:              () => number;
  // When true, a successful provider fetch is NOT written back to the Redis cache. Used by
  // consumer services (signal/trading/portfolio) whose provider (RedisGbpUsdProvider) READS the
  // rate market-data-service publishes — they must not overwrite the authoritative lastGood/lastTs,
  // or a stale rate would look perpetually fresh once market-data stops refreshing.
  readOnly?:         boolean;
}

// Shared Redis keys for the GBP-per-1-USD rate. market-data-service is the single writer (hot key
// + lastGood/lastTs); consumer services read them via RedisGbpUsdProvider.
export const FX_KEYS = {
  rate:     'fx:GBPUSD',          // hot cache, TTL'd
  lastGood: 'fx:GBPUSD:lastGood', // last good rate, no TTL
  lastTs:   'fx:GBPUSD:lastTs',   // unix ms of the last good write
} as const;

export class FxClient {
  private readonly ttlSec:           number;
  private readonly staleFallbackSec: number;
  private readonly minRate:          number;
  private readonly maxRate:          number;
  private readonly now:              () => number;
  private readonly readOnly:         boolean;

  constructor(
    private readonly redis: Pick<RedisClientType, 'get' | 'set' | 'setEx'>,
    private readonly provider: FxRateProvider,
    opts: FxClientOpts = {},
  ) {
    this.ttlSec           = opts.ttlSec           ?? 3600;
    this.staleFallbackSec = opts.staleFallbackSec ?? 24 * 3600;
    this.minRate          = opts.minRate          ?? 0.5;
    this.maxRate          = opts.maxRate          ?? 1.5;
    this.now              = opts.now              ?? (() => Date.now());
    this.readOnly         = opts.readOnly         ?? false;
  }

  // GBP per 1 USD. Throws if no fresh rate is available AND lastGood is older than
  // staleFallbackSec — caller decides whether to halt trading.
  async usdGbpRate(): Promise<number> {
    const cached = await this.redis.get(FX_KEYS.rate);
    if (cached) {
      const r = Number(cached);
      if (this._inBounds(r)) return r;
      // Cached value out of bounds → throw it away and refetch.
      console.warn(`[fx] cached rate ${r} out of bounds, refetching`);
    }
    return this._fetchAndCache();
  }

  async toGBP(m: Money): Promise<number> {
    if (m.currency === 'GBP') return m.amount;
    if (m.currency === 'USD') {
      const rate = await this.usdGbpRate();
      return m.amount * rate;
    }
    // Should be unreachable while Currency = 'GBP' | 'USD'. If a third currency lands
    // and someone forgets to update the union, fail loudly.
    const exhaustive: never = m.currency;
    throw new Error(`FxClient.toGBP: unsupported currency ${exhaustive}`);
  }

  // Convert in the other direction — needed by trading-service when sizing orders:
  // strategy emits a GBP-relative weight, we have NAV in GBP, but T212 wants a quantity
  // in instrument units priced in instrument currency.
  async fromGBP(amountGBP: number, target: Currency): Promise<number> {
    if (target === BASE_CURRENCY) return amountGBP;
    const rate = await this.usdGbpRate();   // GBP per 1 USD
    return amountGBP / rate;                 // → USD
  }

  private async _fetchAndCache(): Promise<number> {
    let rate: number;
    try {
      rate = await this.provider.fetchUsdGbpRate();
      if (!this._inBounds(rate)) {
        throw new Error(`fetched rate ${rate} outside sanity bounds [${this.minRate}, ${this.maxRate}]`);
      }
    } catch (err) {
      // Live fetch failed. Fall back to lastGood if it's young enough.
      const fallback = await this._readLastGood();
      if (fallback != null) {
        console.warn('[fx] live fetch failed, serving stale rate:', err);
        return fallback;
      }
      throw new Error(`fx unavailable: ${err instanceof Error ? err.message : err}`);
    }

    // Persist hot + lastGood. Best-effort; cache write failures don't kill the fetch. readOnly
    // clients (consumers reading market-data's published rate) skip this so they never overwrite
    // the single writer's authoritative lastGood/lastTs.
    if (!this.readOnly) {
      try {
        await Promise.all([
          this.redis.setEx(FX_KEYS.rate,     this.ttlSec, String(rate)),
          this.redis.set(FX_KEYS.lastGood,   String(rate)),
          this.redis.set(FX_KEYS.lastTs,     String(this.now())),
        ]);
      } catch (err) {
        console.warn('[fx] cache write failed (non-fatal):', err);
      }
    }
    return rate;
  }

  private async _readLastGood(): Promise<number | null> {
    const [rateStr, tsStr] = await Promise.all([
      this.redis.get(FX_KEYS.lastGood),
      this.redis.get(FX_KEYS.lastTs),
    ]);
    if (!rateStr || !tsStr) return null;
    const rate = Number(rateStr);
    const ts   = Number(tsStr);
    if (!this._inBounds(rate)) return null;
    if (this.now() - ts > this.staleFallbackSec * 1000) return null;
    return rate;
  }

  private _inBounds(r: number): boolean {
    return Number.isFinite(r) && r >= this.minRate && r <= this.maxRate;
  }
}
