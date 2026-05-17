import { describe, it, expect } from "vitest";
import { HolidayCache, type HolidayProvider } from '../holiday-cache.ts';
import type { HolidayTable, Market } from '../calendar.ts';

// In-memory Mongo stub mimicking the surface of db.collection('market_calendar').
class StubDb {
  store = new Map<string, HolidayTable>();
  writes = 0;
  collection(_name: string) {
    return {
      findOne: async (filter: { market: Market; year: number }) =>
        this.store.get(`${filter.market}:${filter.year}`) ?? null,
      updateOne: async (filter: { market: Market; year: number }, update: { $set: HolidayTable }) => {
        this.writes++;
        this.store.set(`${filter.market}:${filter.year}`, update.$set);
        return { matchedCount: 0, upsertedCount: 1 };
      },
    };
  }
}

class StubProvider implements HolidayProvider {
  constructor(public readonly market: Market) {}
  calls = 0;
  shouldThrow = false;
  table: HolidayTable | null = null;
  async fetchYear(year: number): Promise<HolidayTable> {
    this.calls++;
    if (this.shouldThrow) throw new Error('fx provider boom');
    return this.table ?? {
      market: this.market, year, fullClosures: [], halfDays: [],
      fetchedAt: Date.now(), source: 'ical',
    };
  }
}

function makeFallback(): Record<Market, Record<number, HolidayTable>> {
  return {
    US: {
      2026: {
        market: 'US', year: 2026,
        fullClosures: ['2026-12-25'], halfDays: [],
        fetchedAt: 0, source: 'static-fallback',
      },
    },
    LSE: {
      2026: {
        market: 'LSE', year: 2026,
        fullClosures: ['2026-12-25'], halfDays: [],
        fetchedAt: 0, source: 'static-fallback',
      },
    },
  };
}

describe('HolidayCache', () => {
  it('provider hit on first call, writes Mongo, serves from mem on second', async () => {
    const db = new StubDb();
    const us = new StubProvider('US');
    const lse = new StubProvider('LSE');
    const cache = new HolidayCache(db as any, { US: us, LSE: lse }, makeFallback());
    const t1 = await cache.getTable('US', 2026);
    expect(t1.source).toBe('ical');
    expect(us.calls).toBe(1);
    expect(db.writes).toBe(1);
    const t2 = await cache.getTable('US', 2026);
    expect(us.calls).toBe(1);   // mem hit; no new provider call
    expect(t2).toEqual(t1);
  });

  it('Mongo hit on cold mem if entry is fresh', async () => {
    const db = new StubDb();
    db.store.set('US:2026', {
      market: 'US', year: 2026, fullClosures: ['2026-01-01'], halfDays: [],
      fetchedAt: Date.now(), source: 'ical',
    });
    const us = new StubProvider('US');
    const lse = new StubProvider('LSE');
    const cache = new HolidayCache(db as any, { US: us, LSE: lse }, makeFallback());
    const t = await cache.getTable('US', 2026);
    expect(t.fullClosures).toEqual(['2026-01-01']);
    expect(us.calls).toBe(0);   // didn't hit provider
  });

  it('provider failure falls back to Mongo cached entry (even if stale-by-refresh-interval)', async () => {
    const db = new StubDb();
    // Set the Mongo entry as older than refreshInterval so the cache would normally
    // try the provider next — but provider throws, so we must fall back to Mongo.
    db.store.set('US:2026', {
      market: 'US', year: 2026, fullClosures: ['2026-old-data'], halfDays: [],
      fetchedAt: Date.now() - 30 * 24 * 3600_000, source: 'cache',
    });
    const us = new StubProvider('US');
    us.shouldThrow = true;
    const lse = new StubProvider('LSE');
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const cache = new HolidayCache(db as any, { US: us, LSE: lse }, makeFallback());
      const t = await cache.getTable('US', 2026);
      expect(t.fullClosures).toEqual(['2026-old-data']);
      expect(t.source).toBe('cache');
    } finally {
      console.warn = origWarn;
    }
  });

  it('static fallback is mem-cached so a broken provider is not re-called every getTable', async () => {
    const db = new StubDb();
    const us = new StubProvider('US');
    us.shouldThrow = true;
    const lse = new StubProvider('LSE');
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const cache = new HolidayCache(db as any, { US: us, LSE: lse }, makeFallback());
      await cache.getTable('US', 2026);
      await cache.getTable('US', 2026);
      await cache.getTable('US', 2026);
      // Provider called once (first miss); subsequent calls served from mem'd fallback.
      expect(us.calls).toBe(1);
    } finally {
      console.warn = origWarn;
    }
  });

  it('falls back to static when both provider AND Mongo are unavailable', async () => {
    const db = new StubDb();
    const us = new StubProvider('US');
    us.shouldThrow = true;
    const lse = new StubProvider('LSE');
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const cache = new HolidayCache(db as any, { US: us, LSE: lse }, makeFallback());
      const t = await cache.getTable('US', 2026);
      expect(t.source).toBe('static-fallback');
      expect(t.fullClosures).toEqual(['2026-12-25']);
    } finally {
      console.warn = origWarn;
    }
  });

  it('degrades to empty-closures stub when provider, Mongo, AND fallback all miss', async () => {
    // Operator-relevant case: system uptime spans past the year the static table covers
    // (e.g. running into 2028 with only 2026/2027 baked in). We return a no-holidays
    // stub rather than throw — the gate keeps working, we waste at most a few cycles on
    // unrecognised holidays, operator sees source='never' on portal and ships an update.
    const db = new StubDb();
    const us = new StubProvider('US');
    us.shouldThrow = true;
    const lse = new StubProvider('LSE');
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const cache = new HolidayCache(db as any, { US: us, LSE: lse }, { US: {}, LSE: {} });
      const t = await cache.getTable('US', 2099);
      expect(t.fullClosures).toEqual([]);
      expect(t.halfDays).toEqual([]);
      expect(t.source).toBe('static-fallback');
    } finally {
      console.warn = origWarn;
    }
  });

  it('refreshAll fetches both years for both markets', async () => {
    const db = new StubDb();
    const us = new StubProvider('US');
    const lse = new StubProvider('LSE');
    const cache = new HolidayCache(db as any, { US: us, LSE: lse }, makeFallback());
    await cache.refreshAll();
    // year + (year+1) for each of US, LSE = 4 fetches.
    expect(us.calls).toBe(2);
    expect(lse.calls).toBe(2);
    expect(db.writes).toBe(4);
  });

  it('getSourceHealth reports per-market lastFetchedAt + source', async () => {
    const db = new StubDb();
    const year = new Date().getUTCFullYear();
    db.store.set(`US:${year}`, {
      market: 'US', year, fullClosures: [], halfDays: [],
      fetchedAt: Date.now() - 3600_000, source: 'ical',
    });
    // LSE has no entry — expect 'never'.
    const us = new StubProvider('US');
    const lse = new StubProvider('LSE');
    const cache = new HolidayCache(db as any, { US: us, LSE: lse }, makeFallback());
    const health = await cache.getSourceHealth();
    const usEntry  = health.find((h) => h.market === 'US')!;
    const lseEntry = health.find((h) => h.market === 'LSE')!;
    expect(usEntry.source).toBe('ical');
    expect(usEntry.ageMs).toBeGreaterThan(0);
    expect(lseEntry.source).toBe('never');
    expect(lseEntry.lastFetchedAt).toBeNull();
  });
});
