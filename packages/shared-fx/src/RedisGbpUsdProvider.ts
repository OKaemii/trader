// RedisGbpUsdProvider — reads the GBP-per-1-USD rate that market-data-service publishes to Redis,
// so consumer services (signal / trading / portfolio) need no FX upstream key of their own. This is
// the consumer side of the centralized-FX design: market-data is the single writer (it owns the
// provider key + an hourly refresh), everyone else reads.
//
// Returns the last-good value; throws when it's missing (market-data hasn't published yet) or older
// than maxStaleMs (market-data has stopped refreshing) so the staleness contract is preserved. Pair
// with `new FxClient(redis, provider, { readOnly: true })` so the consumer never writes the keys
// back — otherwise a stale rate would look perpetually fresh.

import type { RedisClientType } from 'redis';
import { FX_KEYS, type FxRateProvider } from './FxClient.ts';

export interface RedisGbpUsdProviderOpts {
  maxStaleMs?: number;       // reject a lastGood older than this (default 26h — market-data refreshes hourly)
  now?:        () => number;
}

export class RedisGbpUsdProvider implements FxRateProvider {
  private readonly maxStaleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly redis: Pick<RedisClientType, 'get'>,
    opts: RedisGbpUsdProviderOpts = {},
  ) {
    this.maxStaleMs = opts.maxStaleMs ?? 26 * 3600_000;
    this.now        = opts.now        ?? (() => Date.now());
  }

  async fetchUsdGbpRate(): Promise<number> {
    const [rateStr, tsStr] = await Promise.all([
      this.redis.get(FX_KEYS.lastGood),
      this.redis.get(FX_KEYS.lastTs),
    ]);
    if (!rateStr) throw new Error('centralized FX rate not published yet (market-data-service)');
    const rate = Number(rateStr);
    if (!(rate > 0)) throw new Error(`centralized FX rate invalid: ${rateStr}`);
    const ts = tsStr ? Number(tsStr) : 0;
    if (this.now() - ts > this.maxStaleMs) {
      throw new Error('centralized FX rate is stale — market-data-service is not refreshing it');
    }
    return rate;
  }
}
