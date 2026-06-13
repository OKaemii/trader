// UniverseManager builds the universe NATIVELY on (symbol, market) (Task 18). This drives the real
// refresh() against a stateful in-memory Mongo to prove the instrument_registry diff writes bare
// `symbol`+`market` rows (no concatenated `ticker` field) AND that the cross-listing dedup keeps the
// US listing over the LSE one — disambiguated by `market`, not a single-string hash. A second case
// proves a stored bare forced-add ({GOOGL, US}) lands in the registry and the active set.

process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Stateful in-memory Mongo (registry + overrides singleton + instrument_metadata cache). The
// registry is keyed on (symbol, market): refresh() issues find({activeTo:null}), find({$or:[{symbol,
// market}]}), insertMany, updateMany ({$or}), updateOne ({symbol,market,activeTo:null}). `matches`
// handles $or and null equality. ──
type RegRow = Record<string, unknown> & { symbol: string; market: string; activeTo: Date | null };
const registry: RegRow[] = [];
const metaCache: Array<Record<string, unknown> & { _id: string }> = [];
let overridesDoc: { adds?: Array<{ symbol: string; market: string }>; removes?: Array<{ symbol: string; market: string }> } | null = null;

function matches(row: Record<string, unknown>, q: Record<string, unknown>): boolean {
  for (const [k, cond] of Object.entries(q)) {
    if (k === '$or') {
      if (!(cond as Array<Record<string, unknown>>).some((clause) => matches(row, clause))) return false;
      continue;
    }
    const v = row[k];
    if (cond === null) { if (v !== null && v !== undefined) return false; }
    else if (v !== cond) return false;
  }
  return true;
}
function applySet(row: Record<string, unknown>, update: Record<string, unknown>): void {
  const set = (update.$set ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(set)) row[k] = v;
}

function collectionFor(name: string) {
  if (name === 'instrument_registry') {
    return {
      find: (q: Record<string, unknown> = {}) => ({ toArray: async () => registry.filter((r) => matches(r, q)) }),
      insertMany: async (docs: RegRow[]) => { registry.push(...docs.map((d) => ({ ...d }))); return { insertedCount: docs.length }; },
      updateMany: async (q: Record<string, unknown>, update: Record<string, unknown>) => {
        let n = 0; for (const r of registry) if (matches(r, q)) { applySet(r, update); n++; } return { modifiedCount: n };
      },
      updateOne: async (q: Record<string, unknown>, update: Record<string, unknown>) => {
        const r = registry.find((x) => matches(x, q)); if (r) applySet(r, update); return { modifiedCount: r ? 1 : 0 };
      },
    };
  }
  if (name === 'portal_universe_overrides') {
    return { findOne: async () => overridesDoc };
  }
  if (name === 'instrument_metadata') {
    // `matches` only handles equality + $or; MongoInstrumentMeta.findMany/needsRefresh query with
    // `_id:{$in}`, `source:{$ne}`, `fetchedAt:{$gte}`. Support those operators here so the real repo
    // drives against this in-memory cache (find().project().toArray() AND find().toArray()).
    const metaMatch = (row: Record<string, unknown>, q: Record<string, unknown>): boolean => {
      for (const [k, cond] of Object.entries(q)) {
        const v = row[k];
        if (cond !== null && typeof cond === 'object') {
          const c = cond as Record<string, unknown>;
          if ('$in' in c && !(c.$in as unknown[]).includes(v)) return false;
          if ('$ne' in c && v === c.$ne) return false;
          if ('$gte' in c && !(v != null && (v as Date) >= (c.$gte as Date))) return false;
        } else if (v !== cond) return false;
      }
      return true;
    };
    return {
      find: (q: Record<string, unknown> = {}) => {
        const rows = () => metaCache.filter((r) => metaMatch(r, q));
        return { project: () => ({ toArray: async () => rows() }), toArray: async () => rows() };
      },
      replaceOne: async (q: { _id: string }, doc: Record<string, unknown>) => {
        const i = metaCache.findIndex((x) => x._id === q._id);
        if (i >= 0) metaCache[i] = { _id: q._id, ...doc } as { _id: string };
        else metaCache.push({ _id: q._id, ...doc } as { _id: string });
        return { acknowledged: true };
      },
    };
  }
  return { find: () => ({ toArray: async () => [] }), aggregate: () => ({ toArray: async () => [] }) };
}

vi.mock('@trader/shared-mongo', () => ({
  COLLECTIONS: {
    INSTRUMENT_REGISTRY: 'instrument_registry',
    PORTAL_UNIVERSE_OVERRIDES: 'portal_universe_overrides',
    INSTRUMENT_METADATA: 'instrument_metadata',
    OHLCV_BARS: 'ohlcv_bars',
  },
  getMongoDb: async () => ({ collection: (n: string) => collectionFor(n) }),
}));

// The T212 catalog the curated path resolves include-lists against. SHEL is cross-listed (US + LSE).
const T212_CATALOG = [
  { ticker: 'AAPL_US_EQ', name: 'Apple',     shortName: 'AAPL', currencyCode: 'USD' },
  { ticker: 'GOOGL_US_EQ', name: 'Alphabet', shortName: 'GOOGL', currencyCode: 'USD' },
  { ticker: 'SHEL_US_EQ', name: 'Shell US',  shortName: 'SHEL', currencyCode: 'USD' },
  { ticker: 'SHELl_EQ',   name: 'Shell LSE', shortName: 'SHEL', currencyCode: 'GBX' },
  { ticker: 'HSBAl_EQ',   name: 'HSBC',      shortName: 'HSBA', currencyCode: 'GBX' },
];
vi.mock('../modules/universe/infrastructure/t212-client.ts', () => ({
  fetchT212Instruments: async () => T212_CATALOG,
}));

// Task 19: the curated path no longer ranks by Yahoo ADV (the call was dropped) — selection is
// include-list order. No yahoo-client mock is needed; the build is deterministic by construction.

const { UniverseManager } = await import('../modules/universe/application/UniverseManager.ts');

function curatedMgr(over: { includeUs?: string[]; includeLse?: string[] } = {}) {
  return new UniverseManager(undefined, {
    source: 'curated', maxSize: 50,
    includeUs: over.includeUs ?? [], includeLse: over.includeLse ?? [],
  }, { sectorClient: null });
}

describe('UniverseManager.refresh — native (symbol, market) registry build (curated)', () => {
  beforeEach(() => { registry.length = 0; metaCache.length = 0; overridesDoc = null; });

  it('writes bare symbol+market rows (no concatenated ticker field) and returns the T212 active set', async () => {
    const active = await curatedMgr({ includeUs: ['AAPL', 'GOOGL'] }).refresh();
    expect(active.sort()).toEqual(['AAPL_US_EQ', 'GOOGL_US_EQ']);

    const aapl = registry.find((r) => r.symbol === 'AAPL' && r.market === 'US');
    expect(aapl).toBeDefined();
    expect(aapl!.activeTo).toBeNull();
    expect(aapl!.addedReason).toBe('universe_refresh');
    // The native build stores ONLY the bare identity — never the concatenated T212 form.
    expect(aapl).not.toHaveProperty('ticker');
    expect(Object.keys(aapl!)).toEqual(expect.arrayContaining(['symbol', 'market', 'name', 'sector', 'adv', 'activeFrom', 'activeTo']));
  });

  it('cross-listing dedup keeps the US listing over the LSE one (disambiguated by market)', async () => {
    // SHEL is in BOTH include lists; the US listing must win, the LSE one dropped.
    const active = await curatedMgr({ includeUs: ['SHEL'], includeLse: ['SHEL', 'HSBA'] }).refresh();
    expect(active).toContain('SHEL_US_EQ');
    expect(active).not.toContain('SHELl_EQ');
    expect(active).toContain('HSBAl_EQ');     // the genuine LSE-only name survives

    const shel = registry.filter((r) => r.symbol === 'SHEL' && r.activeTo === null);
    expect(shel).toHaveLength(1);
    expect(shel[0]!.market).toBe('US');       // kept the US listing
  });

  it('retires a (symbol, market) row that drops out of the next refresh', async () => {
    await curatedMgr({ includeUs: ['AAPL', 'GOOGL'] }).refresh();
    // GOOGL leaves the include list — its row is retired (activeTo stamped), AAPL stays active.
    await curatedMgr({ includeUs: ['AAPL'] }).refresh();
    const googl = registry.find((r) => r.symbol === 'GOOGL' && r.market === 'US');
    expect(googl!.activeTo).toBeInstanceOf(Date);
    expect(googl!.removedReason).toBe('universe_refresh');
    expect(registry.find((r) => r.symbol === 'AAPL' && r.market === 'US')!.activeTo).toBeNull();
  });

  it('lands a stored bare forced-add ({GOOGL, US}) in the registry + active set, stamped override_add', async () => {
    overridesDoc = { adds: [{ symbol: 'GOOGL', market: 'US' }], removes: [] };
    const active = await curatedMgr({ includeUs: ['AAPL'] }).refresh();
    expect(active).toContain('GOOGL_US_EQ');

    const googl = registry.find((r) => r.symbol === 'GOOGL' && r.market === 'US');
    expect(googl).toBeDefined();
    expect(googl!.activeTo).toBeNull();
    expect(googl!.addedReason).toBe('override_add');
    expect(googl).not.toHaveProperty('ticker');
  });

  it('removes a (symbol, market) via a stored forced-remove', async () => {
    overridesDoc = { adds: [], removes: [{ symbol: 'GOOGL', market: 'US' }] };
    const active = await curatedMgr({ includeUs: ['AAPL', 'GOOGL'] }).refresh();
    expect(active).toContain('AAPL_US_EQ');
    expect(active).not.toContain('GOOGL_US_EQ');
  });
});

describe('UniverseManager.refresh — curated sector enrichment via the EDGAR-SIC secondary (Task 19)', () => {
  beforeEach(() => { registry.length = 0; metaCache.length = 0; overridesDoc = null; });

  // A stub EDGAR-SIC sector client: returns the seeded map, asserting fetchSectors is the only contact
  // point (no Yahoo). `as never` since the manager only calls `.fetchSectors`.
  function mgrWithSectors(seed: Record<string, string>, includeUs: string[]) {
    const stub = { fetchSectors: async (tickers: string[]) =>
      Object.fromEntries(tickers.filter((t) => t in seed).map((t) => [t, seed[t]!])) };
    return new UniverseManager(undefined, { source: 'curated', maxSize: 50, includeUs, includeLse: [] },
      { sectorClient: stub as never });
  }

  it('enriches a curated/US name from the EDGAR SIC and persists source=edgar', async () => {
    const active = await mgrWithSectors({ AAPL_US_EQ: 'Technology' }, ['AAPL', 'GOOGL']).refresh();
    expect(active.sort()).toEqual(['AAPL_US_EQ', 'GOOGL_US_EQ']);

    // The enriched sector landed in the meta cache with source 'edgar' (the secondary), AND on the
    // registry row (the refresh backfills a resolved sector).
    const meta = metaCache.find((r) => r._id === 'AAPL_US_EQ');
    expect(meta?.sector).toBe('Technology');
    expect(meta?.source).toBe('edgar');
    const reg = registry.find((r) => r.symbol === 'AAPL' && r.market === 'US');
    expect(reg?.sector).toBe('Technology');

    // GOOGL had no EDGAR sector this refresh → stays 'Unknown' (cap-exempt), no meta row written.
    expect(metaCache.find((r) => r._id === 'GOOGL_US_EQ')).toBeUndefined();
    expect(registry.find((r) => r.symbol === 'GOOGL' && r.market === 'US')?.sector).toBe('Unknown');
  });

  it('an unresolved EDGAR sector leaves the name Unknown (never blocks the refresh)', async () => {
    // The client returns {} (cold/partial lake) — the universe still builds, all names 'Unknown'.
    const active = await mgrWithSectors({}, ['AAPL']).refresh();
    expect(active).toEqual(['AAPL_US_EQ']);
    expect(registry.find((r) => r.symbol === 'AAPL')?.sector).toBe('Unknown');
    expect(metaCache).toHaveLength(0);
  });
});
