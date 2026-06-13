// Mongo wrapper around the `instrument_metadata` collection. Holds the read-through
// cache for sector enrichment so UniverseManager.refresh doesn't have to re-source on
// every cycle.
//
// Doc shape (one per ticker, _id == ticker):
//   {
//     _id:        "AAPL_US_EQ",
//     sector:     "Technology",
//     industry:   "Consumer Electronics",
//     source:     "eodhd" | "edgar" | "manual",
//     fetchedAt:  Date,
//   }
//
// `source`: 'eodhd' (the EODHD screener row, the eodhd_scan primary), 'edgar' (the lake's EDGAR SIC,
// the curated/US secondary — Task 19), or 'manual' (the operator's override). The 'yahoo' source is
// retired with the Yahoo sector client (Thread C); a legacy 'yahoo' row simply ages out / is overwritten
// by the next eodhd/edgar enrichment. `source: 'manual'` always wins — the periodic refresh skips those
// rows. Useful when a source returns the wrong sector or doesn't know the ticker at all (OTC, delisted).
import { Db, Collection } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';

// 'yahoo' is retained in the union ONLY so a legacy cached row (pre-Thread-C) still type-checks on read;
// nothing WRITES it any more (the Yahoo sector client is deleted). New writes are 'eodhd' | 'edgar' | 'manual'.
export type InstrumentMetaSource = 'yahoo' | 'eodhd' | 'edgar' | 'manual';

export interface InstrumentMetaDoc {
  _id:       string;          // ticker
  sector:    string;
  industry?: string;
  source:    InstrumentMetaSource;
  fetchedAt: Date;
}

export interface InstrumentMetaUpsert {
  ticker:    string;
  sector:    string;
  industry?: string;
  source?:   InstrumentMetaSource;  // default 'edgar' (callers always pass an explicit source today)
  fetchedAt?: Date;                  // default now()
}

export class MongoInstrumentMeta {
  private readonly collection: Collection<InstrumentMetaDoc>;

  constructor(private readonly db: Db) {
    this.collection = db.collection<InstrumentMetaDoc>(COLLECTIONS.INSTRUMENT_METADATA);
  }

  /** Single-ticker lookup. Returns null when the ticker has never been enriched. */
  async get(ticker: string): Promise<InstrumentMetaDoc | null> {
    return this.collection.findOne({ _id: ticker });
  }

  /** Bulk lookup. Returns a ticker→doc map for every ticker that has a row. */
  async findMany(tickers: string[]): Promise<Record<string, InstrumentMetaDoc>> {
    if (tickers.length === 0) return {};
    const docs = await this.collection.find({ _id: { $in: tickers } }).toArray();
    const out: Record<string, InstrumentMetaDoc> = {};
    for (const d of docs) out[d._id] = d;
    return out;
  }

  /**
   * Idempotent write. `source` defaults to 'edgar'; an explicit 'manual' marks the row
   * as operator-pinned and the periodic refresh will skip it.
   */
  async upsert(meta: InstrumentMetaUpsert): Promise<void> {
    const doc: InstrumentMetaDoc = {
      _id:       meta.ticker,
      sector:    meta.sector,
      source:    meta.source    ?? 'edgar',
      fetchedAt: meta.fetchedAt ?? new Date(),
      ...(meta.industry !== undefined ? { industry: meta.industry } : {}),
    };
    await this.collection.replaceOne({ _id: meta.ticker }, doc, { upsert: true });
  }

  /**
   * Tickers whose enrichment is missing or older than `staleMs`. Operator-pinned rows
   * (source='manual') are excluded from the staleness check by design — they should
   * only change via explicit admin write, not via auto-refresh.
   *
   * Returns the subset of `tickers` that need a fresh lookup. The complement is the
   * cache hit set.
   */
  async needsRefresh(tickers: string[], staleMs: number, now = Date.now()): Promise<string[]> {
    if (tickers.length === 0) return [];
    const threshold = new Date(now - staleMs);
    const fresh = await this.collection.find({
      _id: { $in: tickers },
      source: { $ne: 'manual' },
      fetchedAt: { $gte: threshold },
    }).project({ _id: 1 }).toArray();
    const freshSet = new Set(fresh.map((d) => d._id));
    // Also keep manual overrides as "fresh" — don't return them.
    const manuals = await this.collection.find({
      _id: { $in: tickers }, source: 'manual',
    }).project({ _id: 1 }).toArray();
    for (const m of manuals) freshSet.add(m._id);
    return tickers.filter((t) => !freshSet.has(t));
  }

  /** Convenience for the internal /universe/sectors endpoint — ticker → sector map. */
  async sectorMap(tickers: string[]): Promise<Record<string, string>> {
    const found = await this.findMany(tickers);
    const out: Record<string, string> = {};
    for (const t of tickers) {
      out[t] = found[t]?.sector ?? 'Unknown';
    }
    return out;
  }
}
