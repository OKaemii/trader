// Integration-shape tests for the per-market gate logic used by pollLoop. We exercise
// the calendar primitives + partitionByMarket together to assert the *decision* the
// pollLoop makes (poll which markets / skip entirely) is correct across a 24h cycle.
// The pollLoop body itself is not exported; testing through the primitives keeps the
// test deterministic and avoids real Yahoo / Mongo I/O.

import { describe, it, expect } from "vitest";
import {
  partitionByMarket, marketStateOf, shouldPollMarket,
  nyseCalendar, lseCalendar,
  type ExchangeCalendar, type HolidayTable, type Market, type MarketState,
} from '@trader/shared-calendar';

function stubCache(tables: Partial<Record<string, HolidayTable>> = {}) {
  return {
    async getTable(market: Market, year: number): Promise<HolidayTable> {
      const t = tables[`${market}:${year}`];
      if (t) return t;
      return {
        market, year, fullClosures: [], halfDays: [],
        fetchedAt: Date.now(), source: 'static-fallback',
      };
    },
  } as any;
}

interface Decision { market: Market; tickers: string[]; state: MarketState }

async function decisions(
  tickers: readonly string[],
  cals: Record<Market, ExchangeCalendar>,
  nowMs: number,
): Promise<{ active: Decision[]; all: Decision[] }> {
  const groups = partitionByMarket(tickers);
  const all: Decision[] = [];
  for (const m of ['US', 'LSE'] as Market[]) {
    if (groups[m].length === 0) continue;
    all.push({ market: m, tickers: groups[m], state: await marketStateOf(cals[m], nowMs) });
  }
  const active = all.filter((d) => d.state === 'REGULAR' || d.state === 'POST' || d.state === 'PRE');
  return { active, all };
}

const universe = ['AAPL_US_EQ', 'MSFT_US_EQ', 'VODl_EQ', 'BPl_EQ'];

describe('per-market poll gate — 24h synthetic cycle', () => {
  const cache = stubCache();
  const cals: Record<Market, ExchangeCalendar> = {
    US:  nyseCalendar(cache),
    LSE: lseCalendar(cache),
  };

  it('Saturday: both markets CLOSED → no active partitions', async () => {
    const sat = Date.parse('2026-05-16T14:00:00Z');
    const { active, all } = await decisions(universe, cals, sat);
    expect(active).toHaveLength(0);
    expect(all.map((d) => d.state)).toEqual(['CLOSED', 'CLOSED']);
  });

  it('Sunday: both markets CLOSED → no active partitions', async () => {
    const sun = Date.parse('2026-05-17T20:00:00Z');
    const { active } = await decisions(universe, cals, sun);
    expect(active).toHaveLength(0);
  });

  it('Monday 09:00 UTC: LSE-only window → US partition skipped', async () => {
    const monMorn = Date.parse('2026-05-18T09:00:00Z');
    const { active, all } = await decisions(universe, cals, monMorn);
    // LSE in REGULAR (opens 07:00 UTC in BST), US in PRE (opens 13:30 UTC).
    // PRE counts as pollable, so both ARE active.
    const usState  = all.find((d) => d.market === 'US')!.state;
    const lseState = all.find((d) => d.market === 'LSE')!.state;
    expect(lseState).toBe('REGULAR');
    expect(usState).toBe('PRE');
    expect(active.map((d) => d.market).sort()).toEqual(['LSE', 'US']);
  });

  it('Monday 04:00 UTC: both markets in PRE → both polled', async () => {
    // 04:00 UTC = midnight EDT (Monday in NY just begun) = 05:00 BST. Both markets
    // see their next session-open ahead today, so both report PRE (pollable). This
    // is the documented behaviour — PRE counts as pollable so deploys land warm.
    const monEarly = Date.parse('2026-05-18T04:00:00Z');
    const { active, all } = await decisions(universe, cals, monEarly);
    const usState  = all.find((d) => d.market === 'US')!.state;
    const lseState = all.find((d) => d.market === 'LSE')!.state;
    expect(lseState).toBe('PRE');
    expect(usState).toBe('PRE');
    expect(active.map((d) => d.market).sort()).toEqual(['LSE', 'US']);
  });

  it('Monday 14:00 UTC: both markets REGULAR → both partitions polled', async () => {
    const monMid = Date.parse('2026-05-18T14:00:00Z');
    const { active } = await decisions(universe, cals, monMid);
    expect(active.map((d) => d.market).sort()).toEqual(['LSE', 'US']);
    for (const d of active) expect(d.state).toBe('REGULAR');
  });

  it('Monday 18:00 UTC: LSE past grace, US still REGULAR → US-only', async () => {
    // LSE closes 16:30 BST = 15:30 UTC. +90min grace ends 17:00 UTC.
    // NYSE closes 16:00 EDT = 20:00 UTC.
    const monLate = Date.parse('2026-05-18T18:00:00Z');
    const { active, all } = await decisions(universe, cals, monLate);
    const lseState = all.find((d) => d.market === 'LSE')!.state;
    const usState  = all.find((d) => d.market === 'US')!.state;
    expect(lseState).toBe('CLOSED');
    expect(usState).toBe('REGULAR');
    expect(active.map((d) => d.market)).toEqual(['US']);
  });

  it('Monday 22:00 UTC: both past post-close grace → no active partitions', async () => {
    // NYSE closes 20:00 UTC, +90min grace ends 21:30 UTC.
    const monPast = Date.parse('2026-05-18T22:00:00Z');
    const { active } = await decisions(universe, cals, monPast);
    expect(active).toHaveLength(0);
  });
});

describe('per-market poll gate — universe filtering', () => {
  const cache = stubCache();
  const cals: Record<Market, ExchangeCalendar> = {
    US:  nyseCalendar(cache),
    LSE: lseCalendar(cache),
  };

  it('US-only universe yields only US partition decision', async () => {
    const mon = Date.parse('2026-05-18T14:00:00Z');
    const { all } = await decisions(['AAPL_US_EQ', 'MSFT_US_EQ'], cals, mon);
    expect(all.map((d) => d.market)).toEqual(['US']);
  });

  it('LSE-only universe yields only LSE partition decision', async () => {
    const mon = Date.parse('2026-05-18T14:00:00Z');
    const { all } = await decisions(['VODl_EQ', 'BPl_EQ'], cals, mon);
    expect(all.map((d) => d.market)).toEqual(['LSE']);
  });

  it('Universe with only OTHER tickers yields no decisions (gate skips)', async () => {
    const mon = Date.parse('2026-05-18T14:00:00Z');
    const { active, all } = await decisions(['BTC_USDT', 'ETH_USDT'], cals, mon);
    expect(all).toHaveLength(0);
    expect(active).toHaveLength(0);
  });
});

describe('per-market poll gate — holiday handling', () => {
  it('Christmas Day with both markets closed → no active partitions', async () => {
    const cache = stubCache({
      'US:2026':  { market: 'US',  year: 2026, fullClosures: ['2026-12-25'], halfDays: [], fetchedAt: 0, source: 'ical' },
      'LSE:2026': { market: 'LSE', year: 2026, fullClosures: ['2026-12-25'], halfDays: [], fetchedAt: 0, source: 'gov-uk' },
    });
    const cals: Record<Market, ExchangeCalendar> = { US: nyseCalendar(cache), LSE: lseCalendar(cache) };
    // 2026-12-25 is a Friday 14:00 UTC.
    const xmas = Date.parse('2026-12-25T14:00:00Z');
    const { active } = await decisions(universe, cals, xmas);
    expect(active).toHaveLength(0);
  });

  it('US half-day (Black Friday) past early-close: US in POST grace → still polled', async () => {
    const cache = stubCache({
      'US:2026': {
        market: 'US', year: 2026, fullClosures: [],
        halfDays: [{ date: '2026-11-27', closeLocal: '13:00' }],
        fetchedAt: 0, source: 'ical',
      },
    });
    const cals: Record<Market, ExchangeCalendar> = { US: nyseCalendar(cache), LSE: lseCalendar(cache) };
    // 2026-11-27 13:30 ET = 18:30 UTC (EST). Within 90min grace from 18:00 UTC.
    const bf = Date.parse('2026-11-27T18:30:00Z');
    expect(await shouldPollMarket(cals.US, bf)).toBe(true);
  });
});
