// FundamentalsCache — read-through company_fundamentals with a monthly TTL refresh. Fundamentals
// change quarterly, so a row older than ttlMs is re-fetched from the provider; fresh rows serve
// from Mongo. Stores raw line items + computed ratios + the QMJ pass flag + market cap, so the
// Scanner page renders pass/fail without recomputing and the strategy host reads it cheaply.

import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import type { Collection } from 'mongodb';
import type { FundamentalsProvider, FundamentalsRaw } from '../infrastructure/FundamentalsProvider.ts';
import { computeRatios, qualityPass, type QmjRatios } from './qmj.ts';
import { tryIdentityOf, tryIdOf, idOf } from '../../../shared/identity.ts';
import { log } from '../../../logger.ts';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export interface FundamentalsDoc {
  _id:          string;        // '<symbol>:<market>' (the bare-identity composite key since Task 16b)
  symbol:       string;        // bare exchange symbol
  market:       string;        // 'US' | 'LSE'
  asOf:         number;        // when fetched (UTC ms) — for a tombstone, when it was last attempted
  // For a REAL row `raw` holds the fetched line items; a TOMBSTONE (see `unavailable`) carries `null`.
  raw:          FundamentalsRaw | null;
  ratios:       QmjRatios | null;
  qualityPass:  boolean;         // a tombstone is `false` (no quality data — never a false PASS)
  marketCapGbp: number | null;   // null = uncomputable cap (renders `—`, never a fabricated £0)
  // Per-name provenance: the concrete upstream this row came from, as the provider reported it on
  // the fetch (`provider.sourceOf`) — `pit-edgar` for a PIT lake hit, or the configured mode
  // (`eodhd`) when the provider resolves every name from one upstream. A REAL row always carries a
  // source string; a TOMBSTONE carries `null` (no upstream resolved it). Lets the scanner show an
  // honest per-name source.
  source:       string | null;
  // Tombstone marker. A name the provider reported `terminal` (can NEVER resolve from this provider:
  // a non-US name with no EDGAR/no Yahoo substitute, or a US name the lake returned a miss for — no
  // CIK / no facts, e.g. TCEHY). A tombstone is a real Mongo row written with `unavailable:true`,
  // `raw/ratios/marketCapGbp/source = null`, `qualityPass:false`, and `asOf:now`, so the stale set
  // drains and the QMJ refresh loop CONVERGES (an `asOf:now` row is fresh, so `refreshStale` stops
  // counting it instead of spinning on a name that can never resolve). A genuine fetch `hit` always
  // overwrites the tombstone with real data. Absent/false ⇒ a real row. Task 8 reads this flag to
  // split coverage (count `unavailable` names separately from genuinely-covered ones).
  unavailable?: boolean;
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
   * Force a full re-source of `tickers` when the provider MODE changed since the last boot (the
   * yahoo→pit flip THIS deploy performs: the prior boot stored `yahoo`, the new code runs `pit`). The
   * TTL refresher never catches this — a doc isn't time-stale, and a stale `yahoo`-sourced US row from
   * the old code is not time-stale either — so the surfaces that read this cache (Research ›
   * Fundamentals, the Scanner) would keep serving the OLD provider's rows for up to the monthly TTL.
   * Persists the mode in `modeStore`; on a change, re-sources the whole universe through the new
   * provider (US → `pit-edgar`; non-US fail-closed, so its old `yahoo` row is left to age out by TTL —
   * the provider returns no doc to overwrite it). The mode key is written only AFTER the walk, so a
   * crash mid-walk retries on the next boot. Same mode ⇒ no-op. Call it backgrounded (`void … .catch`)
   * at boot — a full walk runs for minutes.
   *
   * **US-first, chunked.** Only US (`*_US_EQ`) names get a fresh doc under `pit` (US → the PIT lake,
   * fast + in-cluster); a non-US name is fail-closed (the provider returns nothing for it). Re-sourcing
   * US first, in small chunks, keeps the US writes prompt and isolates any per-chunk failure. A chunk
   * that throws is logged and skipped, never failing the whole walk.
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

  /**
   * Map the requested T212 tickers to their (symbol, market) composite `_id`s since Task 16b, keeping
   * the inverse (`_id` → the requested T212 ticker) so a Mongo read can be re-keyed back to the
   * caller's ticker. An un-routable ticker (not a US/LSE form) is dropped — the same fail-soft drop a
   * stale/CFD name always got. Returns the `_id` list to query + the `_id`→ticker map for re-keying.
   */
  private idMap(tickers: string[]): { ids: string[]; idToTicker: Map<string, string> } {
    const idToTicker = new Map<string, string>();
    for (const t of tickers) {
      const id = tryIdOf(t);
      if (id !== null) idToTicker.set(id, t);
    }
    return { ids: [...idToTicker.keys()], idToTicker };
  }

  /** Read-through: cached docs for `tickers`, refreshing any missing/stale via the provider first.
   *  Keyed on the (symbol, market) composite `_id`; the returned map is re-keyed to the requested
   *  T212 ticker so the caller's contract is unchanged. */
  async get(tickers: string[]): Promise<Record<string, FundamentalsDoc>> {
    if (tickers.length === 0) return {};
    const coll = await this.coll();
    const { ids, idToTicker } = this.idMap(tickers);
    if (ids.length === 0) return {};
    const existing = await coll.find({ _id: { $in: ids } }).toArray();
    const byId = new Map(existing.map((d) => [d._id, d]));
    const now = Date.now();
    const stale = [...idToTicker.entries()]
      .filter(([id]) => { const d = byId.get(id); return !d || now - d.asOf > this.ttlMs; })
      .map(([, ticker]) => ticker);
    if (stale.length > 0) await this.refresh(stale);
    const fresh = await coll.find({ _id: { $in: ids } }).toArray();
    const out: Record<string, FundamentalsDoc> = {};
    for (const d of fresh) {
      const ticker = idToTicker.get(d._id);
      if (ticker !== undefined) out[ticker] = d;
    }
    return out;
  }

  /**
   * Refresh only the missing/stale subset of `tickers` (the same freshness filter `get` applies),
   * without the trailing read. Returns counts so the background refresher can decide its backoff and
   * whether to warn:
   *   • `stale`     — how many names needed work this pass.
   *   • `refreshed` — how many made PROGRESS = `hit` rows written + `terminal` tombstones written. A
   *                   tombstone is progress: the name leaves the stale set (its `asOf:now` is fresh)
   *                   and won't be re-fetched next cycle, so an all-`terminal` residual converges to
   *                   `stale === 0` and the loop idles — it is NOT "no progress".
   *   • `outage`    — names left untouched because the upstream was unreachable (resolvability
   *                   unknown). These stay stale and retry next cycle; `refreshed === 0 && outage > 0`
   *                   is the only genuine "made no progress", and the only case the scheduler warns on.
   * A tombstone treats `asOf:now` as fresh, so a tombstoned name is no longer stale on the next pass —
   * this is what makes the QMJ refresh loop converge.
   */
  async refreshStale(
    tickers: string[],
  ): Promise<{ stale: number; refreshed: number; outage: number }> {
    if (tickers.length === 0) return { stale: 0, refreshed: 0, outage: 0 };
    const coll = await this.coll();
    const { ids, idToTicker } = this.idMap(tickers);
    if (ids.length === 0) return { stale: 0, refreshed: 0, outage: 0 };
    const existing = await coll.find({ _id: { $in: ids } }, { projection: { asOf: 1 } }).toArray();
    const asOfById = new Map(existing.map((d) => [d._id, d.asOf]));
    const now = Date.now();
    const stale = [...idToTicker.entries()]
      .filter(([id]) => { const a = asOfById.get(id); return a == null || now - a > this.ttlMs; })
      .map(([, ticker]) => ticker);
    if (stale.length === 0) return { stale: 0, refreshed: 0, outage: 0 };
    const { written, tombstoned, outage } = await this.refreshWithStatus(stale);
    return { stale: stale.length, refreshed: written + tombstoned, outage };
  }

  /** Read-only: cached docs for `tickers` with NO provider refresh (for the Scanner snapshot). Keyed
   *  on the (symbol, market) composite `_id`; the returned map is re-keyed to the requested ticker. */
  async peek(tickers: string[]): Promise<Record<string, FundamentalsDoc>> {
    if (tickers.length === 0) return {};
    const coll = await this.coll();
    const { ids, idToTicker } = this.idMap(tickers);
    if (ids.length === 0) return {};
    const docs = await coll.find({ _id: { $in: ids } }).toArray();
    const out: Record<string, FundamentalsDoc> = {};
    for (const d of docs) {
      const ticker = idToTicker.get(d._id);
      if (ticker !== undefined) out[ticker] = d;
    }
    return out;
  }

  /** Force a provider fetch + upsert for the given tickers. Returns the number of REAL rows written
   *  (a `hit`); tombstones for `terminal` names are NOT counted here (callers like the admin refresh
   *  endpoint and `refreshIfModeChanged` mean "how many names now have real fundamentals"). For the
   *  fuller breakdown the refresh loop needs to converge, see `refreshWithStatus`. */
  async refresh(tickers: string[]): Promise<number> {
    return (await this.refreshWithStatus(tickers)).written;
  }

  /**
   * The real fetch + persist, returning the per-name outcome split the background refresher needs to
   * converge (`refresh` is the thin "hits-only count" wrapper over this):
   *   • `written`    — `hit` names upserted with real fundamentals.
   *   • `tombstoned` — `terminal` names upserted as a TOMBSTONE (asOf:now, unavailable:true, nulls,
   *                    qualityPass:false). A tombstone leaves the stale set (its `asOf:now` is fresh),
   *                    so a name that can never resolve stops being re-fetched every cycle — this is
   *                    what stops the `refresh made no progress` loop. A later `hit` overwrites it.
   *   • `outage`     — names the provider could not classify (upstream unreachable / non-2xx); their
   *                    resolvability is unknown, so they are left UNTOUCHED (no tombstone) and retry on
   *                    the next cycle. `outage > 0 && written+tombstoned === 0` is the only genuine
   *                    "made no progress" — the case the scheduler still warns on.
   * Both upserts are keyed on the (symbol, market) composite `_id` since Task 16b — an un-routable
   * name (shouldn't occur for a provider-returned status, but defended for parity with `idMap`) is
   * skipped fail-soft.
   */
  private async refreshWithStatus(
    tickers: string[],
  ): Promise<{ written: number; tombstoned: number; outage: number }> {
    if (tickers.length === 0) return { written: 0, tombstoned: 0, outage: 0 };
    const coll = await this.coll();
    // `fetch` returns `{ values, status }`: `values` is the resolved (`hit`) names; `status` carries
    // one entry per input ticker (`hit | terminal | outage`) so we can tombstone `terminal` names and
    // leave `outage` names to retry — the seam that lets the loop converge instead of spinning.
    const fetched = await this.provider.fetch(tickers);
    const now = Date.now();
    let written = 0;
    for (const [ticker, raw] of Object.entries(fetched.values)) {
      const identity = tryIdentityOf(ticker);
      if (identity === null) continue;   // un-routable form — never store a concatenated/legacy key
      // Persist the provider's per-name source when it exposes one (the `pit` provider stamps
      // `pit-edgar` per ticker); otherwise the configured mode is already the per-name truth.
      const source = this.provider.sourceOf?.(ticker) ?? this.source;
      await coll.updateOne(
        { _id: idOf(identity) },
        { $set: {
          symbol: identity.symbol, market: identity.market,
          asOf: now, raw, ratios: computeRatios(raw), qualityPass: qualityPass(raw),
          marketCapGbp: raw.marketCapGbp, source, unavailable: false, updatedAt: now,
        } },
        { upsert: true },
      );
      written++;
    }
    // Tombstone the `terminal` names + tally the `outage` names. A `hit` is already persisted above,
    // so skip any ticker also present in `values` (a status map is per-input; `values` is the
    // authoritative hit set) — a real row must never be clobbered by a tombstone in the same pass.
    let tombstoned = 0;
    let outage = 0;
    for (const [ticker, status] of Object.entries(fetched.status)) {
      if (status === 'hit') continue;
      if (status === 'outage') { outage++; continue; }      // unknown resolvability — leave to retry
      if (ticker in fetched.values) continue;               // already written as a real hit
      const identity = tryIdentityOf(ticker);
      if (identity === null) continue;                      // un-routable — fail-soft skip
      await coll.updateOne(
        { _id: idOf(identity) },
        { $set: {
          symbol: identity.symbol, market: identity.market,
          asOf: now, raw: null, ratios: null, qualityPass: false,
          marketCapGbp: null, source: null, unavailable: true, updatedAt: now,
        } },
        { upsert: true },
      );
      tombstoned++;
    }
    log.info(
      `[fundamentals] refreshed ${written}/${tickers.length} ticker(s) from ${this.source}` +
      (tombstoned > 0 || outage > 0 ? ` (${tombstoned} unavailable, ${outage} outage)` : ''),
    );
    return { written, tombstoned, outage };
  }

  async coverage(): Promise<{ count: number; passing: number; oldestAsOf: number | null }> {
    const coll = await this.coll();
    const docs = await coll.find({}, { projection: { qualityPass: 1, asOf: 1 } }).toArray();
    const passing = docs.filter((d) => d.qualityPass).length;
    const oldestAsOf = docs.reduce<number | null>((min, d) => (min === null ? d.asOf : Math.min(min, d.asOf)), null);
    return { count: docs.length, passing, oldestAsOf };
  }
}
