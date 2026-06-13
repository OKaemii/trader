// Task 16a — signals + positions are stored on the bare (symbol, market) identity. TripRecorder
// snapshots both into the circuit-breaker post-mortem for the /risk/trips/:id forensic view, so it
// must re-derive a `ticker` label from (symbol, market) — otherwise the post-mortem renders "—" for
// every name even with correct new-shape data.

import { describe, it, expect, vi } from 'vitest';
import { TripRecorder, type TripContext } from '../modules/risk/application/TripRecorder.ts';

// Fake Mongo: a collection per name, returning the seeded docs; captures the inserted trip doc.
function fakeDb(seed: { positions: any[]; signals: any[]; rejections: any[] }) {
  let insertedTrip: any = null;
  const collFor = (rows: any[], capture = false) => ({
    find: (_filter: any, _opts?: any) => ({ sort: () => ({ limit: () => ({ toArray: async () => rows }) }), toArray: async () => rows }),
    insertOne: async (doc: any) => { if (capture) insertedTrip = doc; return { acknowledged: true }; },
    findOne: async () => null,
  });
  const db = {
    collection: (name: string) => {
      if (name === 'circuit_breaker_trips') return collFor([], true);
      if (name === 'positions') return collFor(seed.positions);
      if (name === 'risk_rejections') return collFor(seed.rejections);
      if (name === 'signals') return collFor(seed.signals);
      return collFor([]);
    },
  } as any;
  return { db, getTrip: () => insertedTrip };
}

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
const trading = { getCash: async () => ({ free: { amount: 0, currency: 'GBP' }, total: { amount: 0, currency: 'GBP' } }) } as any;
const signalRepo = {} as any;
const ctx: TripContext = { reason: 'DAILY_LOSS_HALT', reasonText: 'daily loss', nav: 100, hwm: 110,
  dayOpenNav: 105, dailyLossPct: 0.04, drawdownPct: 0.09 };

describe('TripRecorder — re-derives ticker labels from (symbol, market)', () => {
  it('stamps a ticker on each snapshotted position + signal (US and LSE)', async () => {
    const { db, getTrip } = fakeDb({
      positions: [{ symbol: 'AAPL', market: 'US', quantity: 10 }, { symbol: 'SHEL', market: 'LSE', quantity: 5 }],
      signals:   [{ id: 's1', symbol: 'MSFT', market: 'US', action: 'BUY' }, { id: 's2', symbol: 'VOD', market: 'LSE', action: 'SELL' }],
      rejections: [],
    });
    const rec = new TripRecorder(db, signalRepo, trading, logger);
    await rec.capture(ctx, ['s1']);
    const trip = getTrip();
    expect(trip.positions.map((p: any) => p.ticker)).toEqual(['AAPL_US_EQ', 'SHELl_EQ']);
    expect(trip.recentSignals.map((s: any) => s.ticker)).toEqual(['MSFT_US_EQ', 'VODl_EQ']);
  });

  it('falls back to a legacy bare `ticker` field on a pre-migration doc', async () => {
    const { db, getTrip } = fakeDb({
      positions: [{ ticker: 'TSLA_US_EQ', quantity: 1 }],   // legacy shape: no symbol/market
      signals:   [{ id: 's1', ticker: 'NVDA_US_EQ', action: 'BUY' }],
      rejections: [],
    });
    const rec = new TripRecorder(db, signalRepo, trading, logger);
    await rec.capture(ctx, []);
    const trip = getTrip();
    expect(trip.positions[0].ticker).toBe('TSLA_US_EQ');
    expect(trip.recentSignals[0].ticker).toBe('NVDA_US_EQ');
  });
});
