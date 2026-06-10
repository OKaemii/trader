// FundamentalsCache — read-through company_fundamentals with a monthly TTL refresh. Fundamentals
// change quarterly, so a row older than ttlMs is re-fetched from the provider; fresh rows serve
// from Mongo. Stores raw line items + computed ratios + the QMJ pass flag + market cap, so the
// Scanner page renders pass/fail without recomputing and the strategy host reads it cheaply.

import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import type { Collection } from 'mongodb';
import type { FundamentalsProvider, FundamentalsRaw } from '../infrastructure/FundamentalsProvider.ts';
import { computeRatios, qualityPass, type QmjRatios } from './qmj.ts';
import { log } from '../../../logger.ts';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export interface FundamentalsDoc {
  _id:          string;        // ticker
  asOf:         number;        // when fetched (UTC ms)
  raw:          FundamentalsRaw;
  ratios:       QmjRatios | null;
  qualityPass:  boolean;
  marketCapGbp: number;
  // Per-name provenance: the concrete upstream this row came from, as the provider reported it on
  // the fetch (`provider.sourceOf`) — `pit-edgar` for a PIT-warehouse hit, `yahoo` for the PIT
  // fall-back (non-US / PIT miss / outage), or the configured mode (`yahoo`/`eodhd`) when the
  // provider resolves every name from one upstream. Lets the scanner show an honest per-name source.
  source:       string;
  updatedAt:    number;
}

export class FundamentalsCache {
  constructor(
    private readonly provider: FundamentalsProvider,
    private readonly source: string,
    private readonly ttlMs = MONTH_MS,
  ) {}

  /**
   * The effective provider mode this cache was built with (`yahoo` | `eodhd` | `pit`) — the live
   * `FUNDAMENTALS_PROVIDER`. The scanner feed-health reports this so the panel reflects the provider
   * actually running, not a re-read of an env var that could drift from the wired cache.
   */
  get effectiveSource(): string {
    return this.source;
  }

  /**
   * Force a full re-source of `tickers` when the provider MODE changed since the last boot (e.g. an
   * operator flips `FUNDAMENTALS_PROVIDER` yahoo→pit). The TTL refresher never catches this — a doc
   * isn't time-stale, and a `yahoo`-sourced US row is a *valid* `pit`-mode fallback — so the surfaces
   * that read this cache (Research › Fundamentals, the Scanner) would keep serving the OLD provider's
   * rows for up to the monthly TTL. Persists the mode in `modeStore`; on a change, re-sources the
   * whole universe through the new provider (US → `pit-edgar`, fallbacks → `yahoo`). The mode key is
   * written only AFTER the walk, so a crash mid-walk retries on the next boot. Same mode ⇒ no-op.
   * Call it backgrounded (`void … .catch`) at boot — a full walk runs for minutes.
   *
   * **US-first, chunked.** A `pit` flip only changes provenance for US (`*_US_EQ`) names (US → the
   * PIT warehouse, fast + in-cluster); non-US stay on the Yahoo fallback regardless. Re-sourcing US
   * first, in small chunks, means a throttled/cooling Yahoo upstream on the non-US tail can't hold up
   * the US writes (the bug: a single batch `refresh(all)` blocked behind the LSE-Yahoo cooldown, so
   * no US row was written). A chunk that throws is logged and skipped, never failing the whole walk.
   */
  async refreshIfModeChanged(
    modeStore: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<unknown> },
    tickers: string[],
  ): Promise<{ changed: boolean; from: string | null; refreshed: number }> {
    const last = await modeStore.get(FundamentalsCache.MODE_KEY);
    if (last === this.source) return { changed: false, from: last, refreshed: 0 };
    log.info(
      `[fundamentals] provider mode ${last ?? '(none)'} → ${this.source}; re-sourcing ` +
      `${tickers.length} ticker(s) (US-first) so cached rows reflect the new provider`,
    );
    const ordered = [...tickers].sort(
      (a, b) => (a.endsWith('_US_EQ') ? 0 : 1) - (b.endsWith('_US_EQ') ? 0 : 1),
    );
    let refreshed = 0;
    for (let i = 0; i < ordered.length; i += FundamentalsCache.MODE_REFRESH_CHUNK) {
      const chunk = ordered.slice(i, i + FundamentalsCache.MODE_REFRESH_CHUNK);
      refreshed += await this.refresh(chunk).catch((err) => {
        log.warn(`[fundamentals] mode-change chunk (${chunk.length}) failed:`, err);
        return 0;
      });
    }
    // Record the mode only after real progress — a wholesale failure (provider down) leaves the key
    // unset so the next boot retries; partial progress is fine (the TTL refresher + per-name reads
    // converge the rest). An empty universe is a vacuous success.
    if (refreshed > 0 || ordered.length === 0) {
      await modeStore.set(FundamentalsCache.MODE_KEY, this.source);
    }
    log.info(`[fundamentals] mode-change re-sourced ${refreshed}/${tickers.length} ticker(s)`);
    return { changed: true, from: last, refreshed };
  }

  /** Redis key holding the provider mode the cache last re-sourced under (mode-change detection). */
  static readonly MODE_KEY = 'market-data:fundamentals:provider_mode';

  /** Chunk size for the mode-change re-source — small so a slow non-US tail can't block US writes. */
  static readonly MODE_REFRESH_CHUNK = 12;

  private async coll(): Promise<Collection<FundamentalsDoc>> {
    return (await getMongoDb()).collection<FundamentalsDoc>(COLLECTIONS.COMPANY_FUNDAMENTALS);
  }

  /** Read-through: cached docs for `tickers`, refreshing any missing/stale via the provider first. */
  async get(tickers: string[]): Promise<Record<string, FundamentalsDoc>> {
    if (tickers.length === 0) return {};
    const coll = await this.coll();
    const existing = await coll.find({ _id: { $in: tickers } }).toArray();
    const byTicker = new Map(existing.map((d) => [d._id, d]));
    const now = Date.now();
    const stale = tickers.filter((t) => { const d = byTicker.get(t); return !d || now - d.asOf > this.ttlMs; });
    if (stale.length > 0) await this.refresh(stale);
    const fresh = await coll.find({ _id: { $in: tickers } }).toArray();
    return Object.fromEntries(fresh.map((d) => [d._id, d]));
  }

  /**
   * Refresh only the missing/stale subset of `tickers` (the same freshness filter `get` applies),
   * without the trailing read. Returns counts so the background refresher can decide its backoff:
   * `stale` is how many needed work, `refreshed` how many the provider actually returned (a gap
   * means the provider was throttled / omitted unknown symbols).
   */
  async refreshStale(tickers: string[]): Promise<{ stale: number; refreshed: number }> {
    if (tickers.length === 0) return { stale: 0, refreshed: 0 };
    const coll = await this.coll();
    const existing = await coll.find({ _id: { $in: tickers } }, { projection: { asOf: 1 } }).toArray();
    const asOfByTicker = new Map(existing.map((d) => [d._id, d.asOf]));
    const now = Date.now();
    const stale = tickers.filter((t) => { const a = asOfByTicker.get(t); return a == null || now - a > this.ttlMs; });
    const refreshed = stale.length > 0 ? await this.refresh(stale) : 0;
    return { stale: stale.length, refreshed };
  }

  /** Read-only: cached docs for `tickers` with NO provider refresh (for the Scanner snapshot). */
  async peek(tickers: string[]): Promise<Record<string, FundamentalsDoc>> {
    if (tickers.length === 0) return {};
    const coll = await this.coll();
    const docs = await coll.find({ _id: { $in: tickers } }).toArray();
    return Object.fromEntries(docs.map((d) => [d._id, d]));
  }

  /** Force a provider fetch + upsert for the given tickers. Returns the number written. */
  async refresh(tickers: string[]): Promise<number> {
    if (tickers.length === 0) return 0;
    const coll = await this.coll();
    const fetched = await this.provider.fetch(tickers);
    const now = Date.now();
    let written = 0;
    for (const [ticker, raw] of Object.entries(fetched)) {
      // Persist the provider's per-name source when it exposes one (the `pit` provider stamps
      // `pit-edgar`/`yahoo` per ticker); otherwise the configured mode is already the per-name truth.
      const source = this.provider.sourceOf?.(ticker) ?? this.source;
      await coll.updateOne(
        { _id: ticker },
        { $set: {
          asOf: now, raw, ratios: computeRatios(raw), qualityPass: qualityPass(raw),
          marketCapGbp: raw.marketCapGbp, source, updatedAt: now,
        } },
        { upsert: true },
      );
      written++;
    }
    log.info(`[fundamentals] refreshed ${written}/${tickers.length} ticker(s) from ${this.source}`);
    return written;
  }

  async coverage(): Promise<{ count: number; passing: number; oldestAsOf: number | null }> {
    const coll = await this.coll();
    const docs = await coll.find({}, { projection: { qualityPass: 1, asOf: 1 } }).toArray();
    const passing = docs.filter((d) => d.qualityPass).length;
    const oldestAsOf = docs.reduce<number | null>((min, d) => (min === null ? d.asOf : Math.min(min, d.asOf)), null);
    return { count: docs.length, passing, oldestAsOf };
  }
}
