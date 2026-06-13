import { describe, it, expect, beforeEach } from 'vitest';
import { MongoInstrumentMeta, type InstrumentMetaDoc } from '../modules/universe/infrastructure/MongoInstrumentMeta.ts';

// In-memory mock of the Mongo collection surface MongoInstrumentMeta actually uses.
// We only model findOne/find().project().toArray()/replaceOne — the unit boundary.
class FakeCollection {
  rows = new Map<string, InstrumentMetaDoc>();

  async findOne(filter: { _id: string }) {
    return this.rows.get(filter._id) ?? null;
  }

  find(filter: { _id?: { $in: string[] }; source?: string | { $ne: string }; fetchedAt?: { $gte: Date } }) {
    let list = Array.from(this.rows.values());
    if (filter._id?.$in) {
      const set = new Set(filter._id.$in);
      list = list.filter((r) => set.has(r._id));
    }
    if (typeof filter.source === 'string') {
      list = list.filter((r) => r.source === filter.source);
    } else if (filter.source?.$ne) {
      const ne = filter.source.$ne;
      list = list.filter((r) => r.source !== ne);
    }
    if (filter.fetchedAt?.$gte) {
      const lo = filter.fetchedAt.$gte.getTime();
      list = list.filter((r) => r.fetchedAt.getTime() >= lo);
    }
    return {
      project: () => ({
        toArray: async () => list,
      }),
      toArray: async () => list,
    };
  }

  async replaceOne(filter: { _id: string }, doc: InstrumentMetaDoc) {
    this.rows.set(filter._id, doc);
  }
}

function wire() {
  const coll = new FakeCollection();
  const repo = new MongoInstrumentMeta({ collection: () => coll } as never);
  return { repo, coll };
}

describe('MongoInstrumentMeta', () => {
  let repo: MongoInstrumentMeta;
  let coll: FakeCollection;

  beforeEach(() => { ({ repo, coll } = wire()); });

  it('upsert + get round-trip', async () => {
    await repo.upsert({ ticker: 'AAPL_US_EQ', sector: 'Technology', industry: 'Consumer Electronics' });
    const got = await repo.get('AAPL_US_EQ');
    expect(got?.sector).toBe('Technology');
    expect(got?.industry).toBe('Consumer Electronics');
    expect(got?.source).toBe('edgar');         // default (Task 19 — was 'yahoo'; Yahoo source retired)
    expect(got?.fetchedAt).toBeInstanceOf(Date);
  });

  it('findMany returns a sparse map keyed by ticker', async () => {
    await repo.upsert({ ticker: 'AAPL_US_EQ', sector: 'Technology' });
    await repo.upsert({ ticker: 'MSFT_US_EQ', sector: 'Technology' });
    const map = await repo.findMany(['AAPL_US_EQ', 'MSFT_US_EQ', 'NEW_US_EQ']);
    expect(Object.keys(map).sort()).toEqual(['AAPL_US_EQ', 'MSFT_US_EQ']);
    expect(map.AAPL_US_EQ.sector).toBe('Technology');
  });

  it('needsRefresh flags missing tickers + tickers older than staleMs', async () => {
    const now = Date.UTC(2026, 4, 19, 12, 0);
    const oneDayMs = 24 * 60 * 60 * 1000;
    const thirtyDayMs = 30 * oneDayMs;

    // Fresh row (2 days old) — should be excluded.
    coll.rows.set('AAPL_US_EQ', {
      _id: 'AAPL_US_EQ', sector: 'Technology', source: 'yahoo',
      fetchedAt: new Date(now - 2 * oneDayMs),
    });
    // Stale row (60 days old) — should be flagged for refresh.
    coll.rows.set('STALE_US_EQ', {
      _id: 'STALE_US_EQ', sector: 'Energy', source: 'yahoo',
      fetchedAt: new Date(now - 60 * oneDayMs),
    });
    // Manual override — even if old, should NEVER be flagged (operator-pinned).
    coll.rows.set('PINNED_US_EQ', {
      _id: 'PINNED_US_EQ', sector: 'Real Estate', source: 'manual',
      fetchedAt: new Date(now - 365 * oneDayMs),
    });

    const need = await repo.needsRefresh(
      ['AAPL_US_EQ', 'STALE_US_EQ', 'PINNED_US_EQ', 'MISSING_US_EQ'],
      thirtyDayMs,
      now,
    );
    expect(need.sort()).toEqual(['MISSING_US_EQ', 'STALE_US_EQ']);
  });

  it('sectorMap fills "Unknown" for tickers that have no row', async () => {
    await repo.upsert({ ticker: 'AAPL_US_EQ', sector: 'Technology' });
    const map = await repo.sectorMap(['AAPL_US_EQ', 'NEW_US_EQ']);
    expect(map).toEqual({ AAPL_US_EQ: 'Technology', NEW_US_EQ: 'Unknown' });
  });

  it('explicit source="manual" persists; second upsert replaces fully', async () => {
    await repo.upsert({ ticker: 'AAPL_US_EQ', sector: 'Tech', source: 'manual' });
    expect((await repo.get('AAPL_US_EQ'))?.source).toBe('manual');
    // A subsequent default-sourced upsert overwrites the row — caller is expected to
    // filter manual rows BEFORE invoking upsert (handled in UniverseManager.refresh).
    await repo.upsert({ ticker: 'AAPL_US_EQ', sector: 'Technology' });
    expect((await repo.get('AAPL_US_EQ'))?.source).toBe('edgar');
  });
});
