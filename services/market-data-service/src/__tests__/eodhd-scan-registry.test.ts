// Registry migration on the FB→META rename. Under UNIVERSE_SOURCE=eodhd_scan the active universe
// is the EODHD screener → mapEodhdToT212 → instrument_registry diff (UniverseManager.refresh). T212
// renamed FB→META in 2021 (operator-confirmed) and META_US_EQ is the orderable ticker, so once the
// scan→T212 seam emits META_US_EQ the existing identity-based diff MUST: (a) ADD META_US_EQ, and
// (b) RETIRE the stale FB_US_EQ row (activeTo stamped, removedReason set) — superseding the rename,
// not leaving both or neither. This drives the real refresh() against a stateful in-memory Mongo so
// the diff is exercised end-to-end, not asserted by inspection.

process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Stateful in-memory Mongo: a single instrument_registry collection + an empty overrides
// singleton + an empty instrument_metadata cache. Supports just the operations refresh() issues
// under the eodhd_scan path: find({activeTo:null}), find({ticker:{$in}}), insertMany, updateMany,
// updateOne, findOne, replaceOne.
type RegRow = Record<string, unknown> & { ticker: string; activeTo: Date | null };
const registry: RegRow[] = [];
const metaCache: Array<Record<string, unknown> & { _id: string }> = [];

function matches(row: Record<string, unknown>, q: Record<string, unknown>): boolean {
  for (const [k, cond] of Object.entries(q)) {
    const v = row[k];
    if (cond !== null && typeof cond === 'object' && '$in' in (cond as object)) {
      if (!(cond as { $in: unknown[] }).$in.includes(v)) return false;
    } else if (cond === null) {
      if (v !== null && v !== undefined) return false;
    } else if (v !== cond) {
      return false;
    }
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
    return { findOne: async () => null };
  }
  if (name === 'instrument_metadata') {
    return {
      find: (q: Record<string, unknown> = {}) => ({ toArray: async () => metaCache.filter((r) => matches(r, q)) }),
      replaceOne: async (q: { _id: string }, doc: Record<string, unknown>) => {
        const i = metaCache.findIndex((x) => x._id === q._id);
        if (i >= 0) metaCache[i] = { _id: q._id, ...doc } as { _id: string };
        else metaCache.push({ _id: q._id, ...doc } as { _id: string });
        return { acknowledged: true };
      },
    };
  }
  // ohlcv_bars etc. — unused under eodhd_scan; return a no-op aggregate/find.
  return {
    find: () => ({ toArray: async () => [] }),
    aggregate: () => ({ toArray: async () => [] }),
  };
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

// The T212 catalog the scanner sees. Two states are exercised per-test by reassigning this.
let t212Catalog: Array<{ ticker: string; name: string; shortName: string; currencyCode: string }> = [];
vi.mock('../modules/universe/infrastructure/t212-client.ts', () => ({
  fetchT212Instruments: async () => t212Catalog,
}));

// The EODHD screener result feeding mapEodhdToT212. Reassigned per-test.
let scanResult: Array<{ code: string; name: string; exchange: string; marketCapGbp: number; sector?: string }> = [];
vi.mock('../modules/universe/infrastructure/eodhd-scan.ts', () => ({
  fetchEodhdCapScan: async () => scanResult,
}));

const { UniverseManager } = await import('../modules/universe/application/UniverseManager.ts');

function seedActiveFb(): void {
  registry.length = 0;
  registry.push({
    ticker: 'FB_US_EQ', name: 'Meta Platforms', sector: 'Communication Services', market: 'US',
    adv: 0, activeFrom: new Date('2026-06-01'), activeTo: null, addedReason: 'universe_refresh', updatedAt: new Date('2026-06-01'),
  });
}

describe('UniverseManager.refresh — FB→META registry migration (eodhd_scan)', () => {
  beforeEach(() => { registry.length = 0; metaCache.length = 0; });

  it('retires the stale FB_US_EQ and adds META_US_EQ when the scan yields Meta (T212 lags, lists FB shortName)', async () => {
    seedActiveFb();
    // T212 catalog still echoes the legacy shortName FB; the scan returns the EODHD post-rebrand code META.
    t212Catalog = [{ ticker: 'FB_US_EQ', name: 'Meta Platforms', shortName: 'FB', currencyCode: 'USD' }];
    scanResult = [{ code: 'META', name: 'Meta Platforms', exchange: 'US', marketCapGbp: 1.3e12, sector: 'Communication Services' }];

    const mgr = new UniverseManager(undefined, { source: 'eodhd_scan', maxSize: 10, minCapGbp: 5e9 }, { sectorClient: null });
    const active = await mgr.refresh();

    // Observable outcome: META_US_EQ is the active member; FB_US_EQ is gone from the active set.
    expect(active).toContain('META_US_EQ');
    expect(active).not.toContain('FB_US_EQ');

    // Registry diff: META_US_EQ inserted active; FB_US_EQ row superseded (activeTo stamped + reason).
    const meta = registry.find((r) => r.ticker === 'META_US_EQ');
    expect(meta).toBeDefined();
    expect(meta!.activeTo).toBeNull();

    const fb = registry.find((r) => r.ticker === 'FB_US_EQ');
    expect(fb).toBeDefined();
    expect(fb!.activeTo).toBeInstanceOf(Date);          // retired, not left active
    expect(fb!.removedReason).toBe('universe_refresh');
  });

  it('lands META_US_EQ directly when the T212 catalog already carries the META shortName', async () => {
    seedActiveFb();
    t212Catalog = [{ ticker: 'META_US_EQ', name: 'Meta Platforms', shortName: 'META', currencyCode: 'USD' }];
    scanResult = [{ code: 'META', name: 'Meta Platforms', exchange: 'US', marketCapGbp: 1.3e12 }];

    const mgr = new UniverseManager(undefined, { source: 'eodhd_scan', maxSize: 10, minCapGbp: 5e9 }, { sectorClient: null });
    const active = await mgr.refresh();

    expect(active).toEqual(['META_US_EQ']);
    expect(registry.find((r) => r.ticker === 'FB_US_EQ')!.activeTo).toBeInstanceOf(Date);
  });
});
