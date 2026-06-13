// CorporateActionsStore — the typed read-through store for cash dividends + stock splits, with an
// INCREMENTAL, credit-thrifty sync (plan §I). One Mongo doc per ticker holds the accreted event
// lists plus two cursors (`lastDividendDate` / `lastSplitDate` = the max stored ex-/split date). A
// sync pass fetches only events newer than those cursors, appends the new ones (idempotent — a date
// already held is skipped), and advances the cursors. A re-sync of a ticker with no new actions
// makes ZERO upstream EODHD calls — the store decides per ticker whether a fetch is even warranted
// (see `syncOne`'s gating), so a current universe spends no credits.
//
// Reads never fetch: `peek` (admin endpoint) and `dividendsFor` (the dividend-yield leg) serve
// whatever the background sync has accreted. Dividend `valuePerShare` is BASE units (pence killed by
// the provider at the boundary), matching the persisted daily `close` — so the yield ratio computed
// downstream is unit-consistent.
//
// New-event hook (plan §8 Gap 1): the store is the single authority on what is genuinely NEW (it
// owns the watermark cursors + the dedupe), so it fires an injected `onNewActions(ticker, summary)`
// callback exactly when a sync appends a previously-unseen dividend/split. The corporate-actions
// watcher binds that callback to a forced daily-series re-backfill so `writeBarRevisions` supersedes
// the now-stale-adjusted history (the provider re-adjusts the whole series on a new action). The
// callback is best-effort — a throw is swallowed so a failed re-adjust never aborts the sync loop.

import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import type { Collection } from 'mongodb';
import type {
  CorporateActionsProvider,
  ProviderDividend,
  ProviderSplit,
} from '../infrastructure/CorporateActionsProvider.ts';
import { tryIdentityOf, tryIdOf, idOf } from '../../../shared/identity.ts';

// A ticker re-checked for new actions no more often than this much wall-clock since its last sync —
// dividends/splits land at most quarterly, so a daily re-check is generous and keeps the fetch side
// near-free. A ticker NEVER synced (no doc / no asOf) is always fetched, regardless of this gate.
const SYNC_TTL_MS = 24 * 60 * 60 * 1000;

export interface StoredDividend {
  date: string;          // 'YYYY-MM-DD' ex-dividend date
  valuePerShare: number; // gross dividend per share, BASE units
  currency?: string;
}

export interface StoredSplit {
  date: string;          // 'YYYY-MM-DD' split-effective date
  ratio: string;         // raw EODHD ratio, e.g. '2/1'
  factor: number;        // share-count multiplier (NaN if unparseable)
}

export interface CorporateActionsDoc {
  _id: string;             // '<symbol>:<market>' (the bare-identity composite key since Task 16b)
  symbol: string;          // bare exchange symbol
  market: string;          // 'US' | 'LSE'
  dividends: StoredDividend[];
  splits: StoredSplit[];
  lastDividendDate?: string;
  lastSplitDate?: string;
  source: string;
  asOf: number;            // last sync attempt (UTC ms) — gates the incremental TTL
  updatedAt: number;
}

// What a sync appended for one ticker — handed to the new-event hook so a listener (the corporate-
// actions watcher) can decide whether a re-adjust is warranted (newDividends + newSplits > 0).
export interface NewActionsSummary {
  newDividends: number;
  newSplits: number;
}

// Fired by `syncOne` when (and only when) a sync appends a previously-unseen dividend/split for
// `ticker`. Best-effort: the store awaits it but swallows any rejection (a failed re-adjust must not
// abort the sync). Plan §8 Gap 1.
export type OnNewActions = (ticker: string, summary: NewActionsSummary) => void | Promise<void>;

// Max 'YYYY-MM-DD' in a list (string compare is date-correct for fixed-width ISO dates), or undefined.
function maxDate(dates: string[]): string | undefined {
  let max: string | undefined;
  for (const d of dates) if (d && (max === undefined || d > max)) max = d;
  return max;
}

export class CorporateActionsStore {
  constructor(
    private readonly provider: CorporateActionsProvider,
    private readonly source: string,
    private readonly ttlMs = SYNC_TTL_MS,
    // Optional new-event hook — fired when a sync appends a previously-unseen action (plan §8 Gap 1).
    // Best-effort; a rejection is swallowed so the re-adjust trigger can never break the sync loop.
    private readonly onNewActions?: OnNewActions,
  ) {}

  private async coll(): Promise<Collection<CorporateActionsDoc>> {
    return (await getMongoDb()).collection<CorporateActionsDoc>(COLLECTIONS.CORPORATE_ACTIONS);
  }

  /** The stored doc for `ticker` (no fetch), or null. Backs the admin read + the dividend-yield leg.
   *  The store is keyed on the (symbol, market) composite `_id` since Task 16b — a ticker that isn't
   *  a recognised US/LSE form has no doc (returns null, fail-soft). */
  async peek(ticker: string): Promise<CorporateActionsDoc | null> {
    const id = tryIdOf(ticker);
    if (id === null) return null;
    return (await this.coll()).findOne({ _id: id });
  }

  /** Stored dividends for `ticker` (no fetch) — the point-in-time dividend-yield input. */
  async dividendsFor(ticker: string): Promise<StoredDividend[]> {
    const doc = await this.peek(ticker);
    return doc?.dividends ?? [];
  }

  /** Stored dividends for many tickers in one query (no fetch) — the per-cycle dividend-yield hot
   *  path. Keyed by the (symbol, market) composite `_id`; the result is re-keyed back to the
   *  requested T212 ticker so the caller's contract is unchanged (an un-routable ticker is skipped). */
  async dividendsForMany(tickers: string[]): Promise<Record<string, StoredDividend[]>> {
    if (tickers.length === 0) return {};
    const idToTicker = new Map<string, string>();
    for (const t of tickers) {
      const id = tryIdOf(t);
      if (id !== null) idToTicker.set(id, t);
    }
    if (idToTicker.size === 0) return {};
    const docs = await (await this.coll()).find({ _id: { $in: [...idToTicker.keys()] } }).toArray();
    const out: Record<string, StoredDividend[]> = {};
    for (const d of docs) {
      const ticker = idToTicker.get(d._id);
      if (ticker !== undefined) out[ticker] = d.dividends ?? [];
    }
    return out;
  }

  async coverage(): Promise<{ count: number; withDividends: number; withSplits: number }> {
    const coll = await this.coll();
    const [count, withDividends, withSplits] = await Promise.all([
      coll.countDocuments({}),
      coll.countDocuments({ 'dividends.0': { $exists: true } }),
      coll.countDocuments({ 'splits.0': { $exists: true } }),
    ]);
    return { count, withDividends, withSplits };
  }

  /**
   * Incrementally sync one ticker. Returns counts so the scheduler can pace and tests can assert the
   * no-op. A ticker synced within `ttlMs` and already holding a cursor is skipped WITHOUT a fetch
   * (`fetched: false`) — this is the §I "zero upstream calls when current" guarantee. Otherwise it
   * fetches dividends/splits since the stored cursors (full history when no cursor yet), appends only
   * genuinely-new dates, and advances the cursors.
   */
  async syncOne(ticker: string, now = Date.now()): Promise<{ fetched: boolean; newDividends: number; newSplits: number }> {
    // The store is keyed on the (symbol, market) composite `_id` since Task 16b. A ticker that isn't
    // a recognised US/LSE form can't be stored — skip it (fail-soft, no fetch, no write).
    const identity = tryIdentityOf(ticker);
    if (identity === null) return { fetched: false, newDividends: 0, newSplits: 0 };
    const id = idOf(identity);
    const coll = await this.coll();
    const existing = await coll.findOne({ _id: id });

    // Gate: a ticker synced recently AND already cursored has nothing worth a credit. A never-synced
    // ticker (no doc, or a doc with no asOf) always fetches its full history once.
    if (existing && existing.asOf != null && now - existing.asOf < this.ttlMs) {
      return { fetched: false, newDividends: 0, newSplits: 0 };
    }

    const [fetchedDivs, fetchedSplits] = await Promise.all([
      this.provider.fetchDividends(ticker, existing?.lastDividendDate),
      this.provider.fetchSplits(ticker, existing?.lastSplitDate),
    ]);

    const haveDivDates = new Set((existing?.dividends ?? []).map((d) => d.date));
    const haveSplitDates = new Set((existing?.splits ?? []).map((s) => s.date));
    const newDivs = dedupeNewDividends(fetchedDivs, haveDivDates);
    const newSplits = dedupeNewSplits(fetchedSplits, haveSplitDates);

    const mergedDivs = [...(existing?.dividends ?? []), ...newDivs].sort((a, b) => a.date.localeCompare(b.date));
    const mergedSplits = [...(existing?.splits ?? []), ...newSplits].sort((a, b) => a.date.localeCompare(b.date));

    const set: Partial<CorporateActionsDoc> = {
      symbol: identity.symbol,
      market: identity.market,
      dividends: mergedDivs,
      splits: mergedSplits,
      source: this.source,
      asOf: now,
      updatedAt: now,
    };
    const lastDividendDate = maxDate(mergedDivs.map((d) => d.date));
    const lastSplitDate = maxDate(mergedSplits.map((s) => s.date));
    if (lastDividendDate !== undefined) set.lastDividendDate = lastDividendDate;
    if (lastSplitDate !== undefined) set.lastSplitDate = lastSplitDate;

    await coll.updateOne({ _id: id }, { $set: set }, { upsert: true });

    // A genuinely-new action landed → notify the listener (re-adjust the daily series). Fired only
    // after the cursors are persisted, so a re-adjust always sees the store consistent. Best-effort:
    // swallow a rejection so a failing re-adjust never aborts this sync (or the batch loop).
    if (this.onNewActions && (newDivs.length > 0 || newSplits.length > 0)) {
      try {
        await this.onNewActions(ticker, { newDividends: newDivs.length, newSplits: newSplits.length });
      } catch { /* best-effort — never let the re-adjust trigger break the sync */ }
    }

    return { fetched: true, newDividends: newDivs.length, newSplits: newSplits.length };
  }

  /** Sync a batch, returning aggregate counts (and how many tickers actually hit upstream). */
  async syncMany(tickers: string[], now = Date.now()): Promise<{ tickers: number; fetched: number; newDividends: number; newSplits: number }> {
    let fetched = 0, newDividends = 0, newSplits = 0;
    for (const t of tickers) {
      const r = await this.syncOne(t, now);
      if (r.fetched) fetched++;
      newDividends += r.newDividends;
      newSplits += r.newSplits;
    }
    return { tickers: tickers.length, fetched, newDividends, newSplits };
  }
}

// Keep only fetched dividends whose date the store doesn't already hold (idempotent re-append).
function dedupeNewDividends(fetched: ProviderDividend[], have: Set<string>): StoredDividend[] {
  const out: StoredDividend[] = [];
  for (const d of fetched) {
    if (!d.date || have.has(d.date) || !Number.isFinite(d.valuePerShare)) continue;
    have.add(d.date);   // guard against a feed returning the same ex-date twice in one page
    out.push({ date: d.date, valuePerShare: d.valuePerShare, ...(d.currency ? { currency: d.currency } : {}) });
  }
  return out;
}

function dedupeNewSplits(fetched: ProviderSplit[], have: Set<string>): StoredSplit[] {
  const out: StoredSplit[] = [];
  for (const s of fetched) {
    if (!s.date || have.has(s.date) || !s.ratio) continue;
    have.add(s.date);
    out.push({ date: s.date, ratio: s.ratio, factor: s.factor });
  }
  return out;
}
