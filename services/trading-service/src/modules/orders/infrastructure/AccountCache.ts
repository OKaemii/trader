import type { Logger } from '@trader/core';
import type { Money } from '@trader/shared-types';
import type { Trading212Client, T212Position } from '../../t212/infrastructure/Trading212Client.ts';
import { scaleT212Quote, type PriceLookupForScaler } from '../../../shared/T212PriceScaler.ts';

// AccountCache — coalesces and caches T212 cash + positions reads so the dispatcher
// doesn't hammer the broker once per signal.
//
// Behaviour:
//   - TTL: snapshot served from memory for `ttlMs` (default 30s).
//   - In-flight coalescing: concurrent callers during a fetch share the same promise.
//   - Stale-fallback on 429/error: if the live fetch fails AND a previous snapshot
//     exists < `staleFallbackMs` old (default 5min), return that snapshot. This lets
//     the dispatcher keep working through transient rate-limit blips without losing
//     accuracy. If no snapshot exists, the error propagates so the dispatcher requeues.
//
// Not concurrency-safe across pods — this is a per-process cache. Multi-pod trading-service
// would each hold their own snapshot, which is fine: T212 is the source of truth and the
// cache is just a request-rate dampener.

export interface AccountSnapshot {
  // Cash: always GBP on a UK T212 account. The Money carrier is explicit so consumers
  // (RiskEngine, AutoApprovalGate) can't accidentally add it to instrument-currency
  // position values without going through FxClient.
  free: Money;
  total: Money;
  positions: T212Position[];
  fetchedAt: number;
}

export interface AccountCacheOpts {
  ttlMs?: number;
  staleFallbackMs?: number;
  now?: () => number;
  logger?: Logger;
  // Optional price lookup used to cross-check T212-reported prices against the stored
  // bar close. Required to detect pence-quoted LSE listings — without it, position
  // prices for tickers like SUPRl_EQ / SGLNl_EQ are returned 100x inflated.
  priceLookup?: PriceLookupForScaler;
}

export class AccountCache {
  private snapshot: AccountSnapshot | null = null;
  private inFlight: Promise<AccountSnapshot> | null = null;
  private readonly ttlMs: number;
  private readonly staleFallbackMs: number;
  private readonly now: () => number;
  private readonly logger: Logger | null;
  private readonly priceLookup: PriceLookupForScaler | null;

  constructor(
    private readonly client: Pick<Trading212Client, 'getCash' | 'getPositions'>,
    opts: AccountCacheOpts = {},
  ) {
    this.ttlMs           = opts.ttlMs           ?? 30_000;
    this.staleFallbackMs = opts.staleFallbackMs ?? 5 * 60_000;
    this.now             = opts.now             ?? (() => Date.now());
    this.logger          = opts.logger          ?? null;
    this.priceLookup     = opts.priceLookup     ?? null;
  }

  async get(): Promise<AccountSnapshot> {
    const t = this.now();
    if (this.snapshot && t - this.snapshot.fetchedAt < this.ttlMs) return this.snapshot;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this._fetch()
      .then((snap) => {
        this.snapshot = snap;
        return snap;
      })
      .catch((err) => {
        // Stale-fallback: if we have a recent-enough prior snapshot, serve it through the
        // error and let the dispatcher proceed. Without this, a single T212 429 takes the
        // whole queue offline until cache TTL clears.
        if (this.snapshot && this.now() - this.snapshot.fetchedAt < this.staleFallbackMs) {
          if (this.logger) this.logger.warn({ err }, 'account-cache: live fetch failed, serving stale snapshot');
          return this.snapshot;
        }
        throw err;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  // Force-invalidate after a known mutation (e.g. successful order placement). Doesn't
  // refetch — next get() will hit T212.
  invalidate(): void {
    this.snapshot = null;
  }

  private async _fetch(): Promise<AccountSnapshot> {
    const [cash, positions] = await Promise.all([
      this.client.getCash(),
      this.client.getPositions(),
    ]);
    const scaled = this.priceLookup
      ? await this._scalePositions(positions, this.priceLookup)
      : positions;
    return {
      free:      cash.free,
      total:     cash.total,
      positions: scaled,
      fetchedAt: this.now(),
    };
  }

  private async _scalePositions(positions: T212Position[], lookup: PriceLookupForScaler): Promise<T212Position[]> {
    const logger = this.logger ?? undefined;
    return Promise.all(positions.map(async (p): Promise<T212Position> => {
      // The position already carries its bare (symbol, market) identity (parsed at the client
      // boundary); the pence-kill keys on market, so pass the identity straight through.
      const id = { symbol: p.symbol, market: p.market };
      const avg  = await scaleT212Quote(id, p.averagePrice.amount, lookup, logger);
      const curr = await scaleT212Quote(id, p.currentPrice.amount, lookup, logger);
      if (avg === p.averagePrice.amount && curr === p.currentPrice.amount) return p;
      return {
        ...p,
        averagePrice: { amount: avg,  currency: p.averagePrice.currency },
        currentPrice: { amount: curr, currency: p.currentPrice.currency },
        currentValue: { amount: curr * p.quantity, currency: p.currentValue.currency },
      };
    }));
  }
}
