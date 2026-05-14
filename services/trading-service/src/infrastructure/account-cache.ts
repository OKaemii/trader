import type { Trading212Client } from './t212.ts';

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
  free: number;
  total: number;
  positions: Array<{ ticker: string; quantity: number; averagePrice?: number; currentPrice?: number }>;
  fetchedAt: number;
}

export interface AccountCacheOpts {
  ttlMs?: number;
  staleFallbackMs?: number;
  now?: () => number;
}

export class AccountCache {
  private snapshot: AccountSnapshot | null = null;
  private inFlight: Promise<AccountSnapshot> | null = null;
  private readonly ttlMs: number;
  private readonly staleFallbackMs: number;
  private readonly now: () => number;

  constructor(
    private readonly client: Pick<Trading212Client, 'getCash' | 'getPositions'>,
    opts: AccountCacheOpts = {},
  ) {
    this.ttlMs           = opts.ttlMs           ?? 30_000;
    this.staleFallbackMs = opts.staleFallbackMs ?? 5 * 60_000;
    this.now             = opts.now             ?? (() => Date.now());
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
          console.warn('[account-cache] live fetch failed, serving stale snapshot:', err);
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
    const [cash, rawPositions] = await Promise.all([
      this.client.getCash(),
      this.client.getPositions() as Promise<Array<Record<string, unknown>>>,
    ]);
    const positions = (rawPositions ?? []).map((p) => ({
      ticker:        String(p.ticker ?? ''),
      quantity:      Number(p.quantity ?? 0),
      averagePrice:  typeof p.averagePrice === 'number' ? p.averagePrice : undefined,
      currentPrice:  typeof p.currentPrice === 'number' ? p.currentPrice : undefined,
    }));
    return {
      free:      Number(cash.free ?? 0),
      total:     Number(cash.total ?? cash.free ?? 0),
      positions,
      fetchedAt: this.now(),
    };
  }
}
