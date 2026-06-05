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
  source:       string;
  updatedAt:    number;
}

export class FundamentalsCache {
  constructor(
    private readonly provider: FundamentalsProvider,
    private readonly source: string,
    private readonly ttlMs = MONTH_MS,
  ) {}

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
      await coll.updateOne(
        { _id: ticker },
        { $set: {
          asOf: now, raw, ratios: computeRatios(raw), qualityPass: qualityPass(raw),
          marketCapGbp: raw.marketCapGbp, source: this.source, updatedAt: now,
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
