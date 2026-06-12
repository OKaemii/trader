// Calendar logic tests. Avoids the HolidayCache infrastructure by passing a stub
// that returns a hardcoded HolidayTable.

import { describe, it, expect } from "vitest";
import {
  marketStateOf, shouldPollMarket, partitionByMarket, nextOpen, nextClose,
  expectedLatestBarMs, scheduleBetween, localTimeToUtc, formatLocalDate, dayOfWeekIn,
  nextEodPollInstant, soonestEodPollInstant,
} from '../calendar.ts';
import type { ExchangeCalendar, HolidayTable } from '../calendar.ts';
import { nyseCalendar } from '../nyse.ts';
import { lseCalendar } from '../lse.ts';
import { Trading212TickerAdapter, type TickerIdentity } from '@trader/ticker-identity';

// Minimal HolidayCache stub. Tests inject their own tables per-year per-market.
function stubCache(tables: Partial<Record<string, HolidayTable>> = {}) {
  return {
    async getTable(market: 'US' | 'LSE', year: number): Promise<HolidayTable> {
      const t = tables[`${market}:${year}`];
      if (t) return t;
      // Default: no holidays, no half-days. Lets tests focus on weekday/weekend logic.
      return {
        market, year, fullClosures: [], halfDays: [],
        fetchedAt: Date.now(), source: 'static-fallback',
      };
    },
  } as any;
}

function nyse(tables?: Partial<Record<string, HolidayTable>>): ExchangeCalendar {
  return nyseCalendar(stubCache(tables));
}
function lse(tables?: Partial<Record<string, HolidayTable>>): ExchangeCalendar {
  return lseCalendar(stubCache(tables));
}

describe('localTimeToUtc — DST correctness', () => {
  it('NY 09:30 local → 13:30 UTC in summer (EDT, UTC-4)', () => {
    // 2026-07-15 is in EDT.
    const utc = localTimeToUtc('2026-07-15', '09:30', 'America/New_York');
    expect(new Date(utc).toISOString()).toBe('2026-07-15T13:30:00.000Z');
  });

  it('NY 09:30 local → 14:30 UTC in winter (EST, UTC-5)', () => {
    // 2026-01-15 is EST.
    const utc = localTimeToUtc('2026-01-15', '09:30', 'America/New_York');
    expect(new Date(utc).toISOString()).toBe('2026-01-15T14:30:00.000Z');
  });

  it('LSE 08:00 local → 07:00 UTC in summer (BST, UTC+1)', () => {
    const utc = localTimeToUtc('2026-07-15', '08:00', 'Europe/London');
    expect(new Date(utc).toISOString()).toBe('2026-07-15T07:00:00.000Z');
  });

  it('LSE 08:00 local → 08:00 UTC in winter (GMT, UTC+0)', () => {
    const utc = localTimeToUtc('2026-01-15', '08:00', 'Europe/London');
    expect(new Date(utc).toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });

  it('handles US/UK DST mismatch — first 2 weeks of November 2025', () => {
    // US returned to EST Nov 2 2025; UK stayed in GMT (returned Oct 26).
    // Both are in standard time, no mismatch this date. But check March:
    // US went to EDT Mar 9 2025; UK stayed in GMT until Mar 30. Between Mar 9-30:
    //   - NY opens 09:30 EDT = 13:30 UTC
    //   - LSE opens 08:00 GMT = 08:00 UTC
    // So the gap is 5.5h (vs 4.5h once UK transitions).
    const nyOpen  = localTimeToUtc('2025-03-15', '09:30', 'America/New_York');
    const lseOpen = localTimeToUtc('2025-03-15', '08:00', 'Europe/London');
    expect(new Date(nyOpen).toISOString()).toBe('2025-03-15T13:30:00.000Z');
    expect(new Date(lseOpen).toISOString()).toBe('2025-03-15T08:00:00.000Z');
  });
});

describe('marketStateOf — NYSE weekday', () => {
  // Wednesday 2026-05-13 (no holiday).
  const t = (h: number, m: number) =>
    Date.parse(`2026-05-13T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);

  it('09:00 UTC (before open) → PRE', async () => {
    const s = await marketStateOf(nyse(), t(9, 0));
    expect(s).toBe('PRE');
  });

  it('14:00 UTC (open) → REGULAR', async () => {
    const s = await marketStateOf(nyse(), t(14, 0));
    expect(s).toBe('REGULAR');
  });

  it('20:30 UTC (just before close) → REGULAR', async () => {
    const s = await marketStateOf(nyse(), t(19, 30));
    expect(s).toBe('REGULAR');
  });

  it('20:30 UTC (post-close, within 90min grace) → POST', async () => {
    // NYSE closes 20:00 UTC in May (EDT). 20:30 is in 90min grace.
    const s = await marketStateOf(nyse(), t(20, 30));
    expect(s).toBe('POST');
  });

  it('22:00 UTC (past grace) → CLOSED', async () => {
    const s = await marketStateOf(nyse(), t(22, 0));
    expect(s).toBe('CLOSED');
  });
});

describe('marketStateOf — weekend', () => {
  it('Saturday 14:00 UTC → CLOSED', async () => {
    // 2026-05-16 is a Saturday.
    const sat = Date.parse('2026-05-16T14:00:00Z');
    expect(await marketStateOf(nyse(), sat)).toBe('CLOSED');
    expect(await marketStateOf(lse(),  sat)).toBe('CLOSED');
  });
});

describe('marketStateOf — full-day holiday', () => {
  it('NYSE Christmas Day → CLOSED even during regular hours', async () => {
    const tables = {
      'US:2026': {
        market: 'US' as const, year: 2026,
        fullClosures: ['2026-12-25'], halfDays: [],
        fetchedAt: 0, source: 'ical' as const,
      },
    };
    // Christmas 2026 is a Friday.
    const xmas14utc = Date.parse('2026-12-25T15:00:00Z');
    expect(await marketStateOf(nyse(tables), xmas14utc)).toBe('CLOSED');
  });
});

describe('marketStateOf — half-day', () => {
  it('NYSE Black Friday closes at 13:00 ET (18:00 UTC in non-DST or 17:00 in DST)', async () => {
    const tables = {
      'US:2026': {
        market: 'US' as const, year: 2026,
        fullClosures: [],
        halfDays: [{ date: '2026-11-27', closeLocal: '13:00' }],
        fetchedAt: 0, source: 'ical' as const,
      },
    };
    // Nov 27 2026 — US already in EST (clock back Nov 1). 13:00 EST = 18:00 UTC.
    const closeBoundary = Date.parse('2026-11-27T17:55:00Z');
    const afterClose    = Date.parse('2026-11-27T18:05:00Z');
    expect(await marketStateOf(nyse(tables), closeBoundary)).toBe('REGULAR');
    expect(await marketStateOf(nyse(tables), afterClose)).toBe('POST');
  });
});

describe('marketStateOf — 2027 weekend shifts (static fallback)', () => {
  // Locks in the tricky 2027 observances baked into STATIC_FALLBACK so a future edit can't
  // silently regress them. Weekdays verified: 2027-12-24 = Fri, 2027-07-05 = Mon, 2027-07-02 = Fri.
  const us2027 = (fullClosures: string[], halfDays: { date: string; closeLocal: string }[] = []) => ({
    'US:2027': { market: 'US' as const, year: 2027, fullClosures, halfDays, fetchedAt: 0, source: 'static-fallback' as const },
  });
  const lse2027 = (halfDays: { date: string; closeLocal: string }[]) => ({
    'LSE:2027': { market: 'LSE' as const, year: 2027, fullClosures: [], halfDays, fetchedAt: 0, source: 'static-fallback' as const },
  });

  it('2027-12-24: US observed-Christmas is CLOSED all day, LSE is a 12:30 half-day', async () => {
    // Dec 25 2027 is a Saturday → US observes Christmas on Fri Dec 24 (full closure). The same
    // Friday is a half-day (not a closure) for LSE: Christmas Eve, 12:30 GMT close.
    const usRegular = Date.parse('2027-12-24T15:00:00Z');   // would be EST regular hours but for the closure
    expect(await marketStateOf(nyse(us2027(['2027-12-24'])), usRegular)).toBe('CLOSED');

    const lseTables    = lse2027([{ date: '2027-12-24', closeLocal: '12:30' }]);
    const lseMorning   = Date.parse('2027-12-24T10:00:00Z');  // before the 12:30 GMT half-day close
    const lseAfterHalf = Date.parse('2027-12-24T12:35:00Z');  // just after the half-day close → POST (grace)
    expect(await marketStateOf(lse(lseTables), lseMorning)).toBe('REGULAR');
    expect(await marketStateOf(lse(lseTables), lseAfterHalf)).toBe('POST');
  });

  it('2027 Independence Day shifts to Mon Jul 5 (CLOSED); Fri Jul 2 stays a normal session', async () => {
    // Jul 4 2027 is a Sunday → observed Mon Jul 5. Unlike 2026, Jul 2/3 carry no special closure.
    const tables = us2027(['2027-07-05']);
    const monJul5 = Date.parse('2027-07-05T15:00:00Z');   // would be EDT regular hours but for the closure
    const friJul2 = Date.parse('2027-07-02T15:00:00Z');   // a normal full trading day in 2027
    const satJul3 = Date.parse('2027-07-03T15:00:00Z');   // weekend — closed, but not a holiday
    expect(await marketStateOf(nyse(tables), monJul5)).toBe('CLOSED');
    expect(await marketStateOf(nyse(tables), friJul2)).toBe('REGULAR');
    expect(await marketStateOf(nyse(tables), satJul3)).toBe('CLOSED');
  });
});

describe('partitionByMarket', () => {
  it('splits a mixed universe by the identity market field', () => {
    const ids: TickerIdentity[] = [
      { symbol: 'AAPL', market: 'US' },
      { symbol: 'VOD', market: 'LSE' },
      { symbol: 'MSFT', market: 'US' },
      { symbol: 'BP', market: 'LSE' },
    ];
    const groups = partitionByMarket(ids);
    expect(groups.US).toEqual([
      { symbol: 'AAPL', market: 'US' },
      { symbol: 'MSFT', market: 'US' },
    ]);
    expect(groups.LSE).toEqual([
      { symbol: 'VOD', market: 'LSE' },
      { symbol: 'BP', market: 'LSE' },
    ]);
  });

  it('returns empty arrays for empty input', () => {
    const groups = partitionByMarket([]);
    expect(groups.US).toEqual([]);
    expect(groups.LSE).toEqual([]);
  });

  // Parity guard: the identity partition must reproduce the OLD suffix-regex split exactly.
  // We bridge the legacy T212-form set the same way the poll loop now does — fromT212 per
  // ticker, routing an unparseable form (the adapter throws) to an OTHER bucket — then assert
  // the US/LSE membership matches what `/_US_EQ$/` and `/l_EQ$/` produced before this change.
  it('reproduces the legacy suffix split for a representative T212 set', () => {
    const adapter = new Trading212TickerAdapter();
    const t212 = ['AAPL_US_EQ', 'VODl_EQ', 'MSFT_US_EQ', 'BPl_EQ', 'SHELl_EQ', 'BTC_USDT'];

    // Old behaviour, recomputed inline from the exact regexes the old function used.
    const expected = { US: [] as string[], LSE: [] as string[], OTHER: [] as string[] };
    for (const t of t212) {
      if (/_US_EQ$/.test(t)) expected.US.push(t);
      else if (/l_EQ$/.test(t)) expected.LSE.push(t);
      else expected.OTHER.push(t);
    }

    // New bridge: parse each form to an identity (OTHER = adapter rejection), partition, map back.
    const ids: TickerIdentity[] = [];
    const other: string[] = [];
    for (const t of t212) {
      try {
        ids.push(adapter.fromT212(t));
      } catch {
        other.push(t);
      }
    }
    const groups = partitionByMarket(ids);
    const usT212 = groups.US.map((id) => adapter.toT212(id));
    const lseT212 = groups.LSE.map((id) => adapter.toT212(id));

    expect(usT212).toEqual(expected.US);          // ['AAPL_US_EQ', 'MSFT_US_EQ']
    expect(lseT212).toEqual(expected.LSE);         // ['VODl_EQ', 'BPl_EQ', 'SHELl_EQ']
    expect(other).toEqual(expected.OTHER);         // ['BTC_USDT']
  });
});

describe('shouldPollMarket', () => {
  it('true during REGULAR/POST/PRE', async () => {
    const cal = nyse();
    expect(await shouldPollMarket(cal, Date.parse('2026-05-13T14:00:00Z'))).toBe(true);  // REGULAR
    expect(await shouldPollMarket(cal, Date.parse('2026-05-13T20:30:00Z'))).toBe(true);  // POST
    expect(await shouldPollMarket(cal, Date.parse('2026-05-13T09:00:00Z'))).toBe(true);  // PRE
  });
  it('false on weekend', async () => {
    const cal = nyse();
    expect(await shouldPollMarket(cal, Date.parse('2026-05-16T14:00:00Z'))).toBe(false);
  });
});

describe('nextOpen / nextClose', () => {
  it('next open on Friday evening → Monday open', async () => {
    // 2026-05-15 Friday 22:00 UTC (past NYSE close + grace).
    const fri = Date.parse('2026-05-15T22:00:00Z');
    const next = await nextOpen(nyse(), fri);
    // 2026-05-18 Monday, NYSE opens 09:30 ET = 13:30 UTC (EDT).
    expect(new Date(next).toISOString()).toBe('2026-05-18T13:30:00.000Z');
  });

  it('next open from mid-session is tomorrow', async () => {
    const wed = Date.parse('2026-05-13T15:00:00Z');   // mid-REGULAR
    const next = await nextOpen(nyse(), wed);
    expect(new Date(next).toISOString()).toBe('2026-05-14T13:30:00.000Z');
  });

  it('next open skips a holiday', async () => {
    // 2026-07-03 is Friday observed-July 4 closure. 07-02 is the half-day.
    const tables = {
      'US:2026': {
        market: 'US' as const, year: 2026,
        fullClosures: ['2026-07-03'],
        halfDays: [],
        fetchedAt: 0, source: 'ical' as const,
      },
    };
    // Thursday 2026-07-02 22:00 UTC after close.
    const thu = Date.parse('2026-07-02T22:00:00Z');
    const next = await nextOpen(nyse(tables), thu);
    // Skip Friday, weekend → next open Monday 2026-07-06.
    expect(new Date(next).toISOString()).toBe('2026-07-06T13:30:00.000Z');
  });

  it('next close from PRE returns same day close', async () => {
    const wed = Date.parse('2026-05-13T09:00:00Z');   // PRE
    const next = await nextClose(nyse(), wed);
    expect(new Date(next).toISOString()).toBe('2026-05-13T20:00:00.000Z');   // 16:00 EDT
  });
});

describe('nextEodPollInstant / soonestEodPollInstant', () => {
  const DELAY = 65 * 60_000;   // matches market-data EOD_POLL_DELAY_MS

  it('mid-session returns today close + delay', async () => {
    // Wednesday 2026-05-13 15:00 UTC (mid-REGULAR, EDT close 20:00 UTC).
    const wedMid = Date.parse('2026-05-13T15:00:00Z');
    const next = await nextEodPollInstant(nyse(), DELAY, wedMid);
    expect(new Date(next).toISOString()).toBe('2026-05-13T21:05:00.000Z');  // 20:00 + 65min
  });

  it('mid-POST (boot just after close, before delay) still returns today instant', async () => {
    // 2026-05-13 20:30 UTC — past close (20:00) but before close+65min.
    const post = Date.parse('2026-05-13T20:30:00Z');
    const next = await nextEodPollInstant(nyse(), DELAY, post);
    expect(new Date(next).toISOString()).toBe('2026-05-13T21:05:00.000Z');
  });

  it('after today instant rolls to next session day', async () => {
    // 2026-05-13 21:30 UTC — past close+65min (21:05) → tomorrow's close+delay.
    const after = Date.parse('2026-05-13T21:30:00Z');
    const next = await nextEodPollInstant(nyse(), DELAY, after);
    expect(new Date(next).toISOString()).toBe('2026-05-14T21:05:00.000Z');
  });

  it('Friday evening rolls to Monday close + delay', async () => {
    const friEve = Date.parse('2026-05-15T22:00:00Z');   // past Fri close+delay
    const next = await nextEodPollInstant(nyse(), DELAY, friEve);
    expect(new Date(next).toISOString()).toBe('2026-05-18T21:05:00.000Z');  // Mon
  });

  it('soonest picks the earlier-closing market (LSE closes before NYSE)', async () => {
    // 2026-05-13 09:00 UTC. LSE close 16:30 BST = 15:30 UTC → +65min = 16:35 UTC.
    // NYSE close 20:00 UTC → +65min = 21:05 UTC. LSE is sooner.
    const morn = Date.parse('2026-05-13T09:00:00Z');
    const soonest = await soonestEodPollInstant([nyse(), lse()], DELAY, morn);
    expect(new Date(soonest).toISOString()).toBe('2026-05-13T16:35:00.000Z');
  });

  it('after LSE poll instant, soonest becomes NYSE the same day', async () => {
    // 2026-05-13 17:00 UTC — past LSE+delay (16:35), before NYSE+delay (21:05).
    const afterLse = Date.parse('2026-05-13T17:00:00Z');
    const soonest = await soonestEodPollInstant([nyse(), lse()], DELAY, afterLse);
    expect(new Date(soonest).toISOString()).toBe('2026-05-13T21:05:00.000Z');
  });
});

describe('expectedLatestBarMs', () => {
  it('Monday morning returns last Friday close', async () => {
    // Monday 2026-05-18 08:00 UTC (before NYSE opens at 13:30 UTC).
    const monMorn = Date.parse('2026-05-18T08:00:00Z');
    const exp = await expectedLatestBarMs(nyse(), monMorn);
    // Friday 2026-05-15 close = 20:00 UTC.
    expect(new Date(exp!).toISOString()).toBe('2026-05-15T20:00:00.000Z');
  });

  it('Mid-Wednesday session returns today open is not it — yesterday close', async () => {
    // Wednesday 2026-05-13 15:00 UTC (mid-REGULAR; today's close hasn't happened).
    const wedMid = Date.parse('2026-05-13T15:00:00Z');
    const exp = await expectedLatestBarMs(nyse(), wedMid);
    // Tuesday 2026-05-12 close = 20:00 UTC.
    expect(new Date(exp!).toISOString()).toBe('2026-05-12T20:00:00.000Z');
  });

  it('Wednesday after close returns today close', async () => {
    const wedAfterClose = Date.parse('2026-05-13T22:00:00Z');
    const exp = await expectedLatestBarMs(nyse(), wedAfterClose);
    expect(new Date(exp!).toISOString()).toBe('2026-05-13T20:00:00.000Z');
  });

  it('Tuesday after a Monday holiday returns Friday close', async () => {
    const tables = {
      'US:2026': {
        market: 'US' as const, year: 2026,
        fullClosures: ['2026-05-25'],   // Memorial Day (Monday)
        halfDays: [],
        fetchedAt: 0, source: 'ical' as const,
      },
    };
    // Tuesday 2026-05-26 08:00 UTC.
    const tueMorn = Date.parse('2026-05-26T08:00:00Z');
    const exp = await expectedLatestBarMs(nyse(tables), tueMorn);
    // Friday 2026-05-22 close = 20:00 UTC.
    expect(new Date(exp!).toISOString()).toBe('2026-05-22T20:00:00.000Z');
  });
});

describe('scheduleBetween', () => {
  it('returns weekday session info + weekend closed entries', async () => {
    // Mon 2026-05-11 through Sun 2026-05-17.
    const fromMs = Date.parse('2026-05-11T00:00:00Z');
    const toMs   = Date.parse('2026-05-17T23:59:59Z');
    const sched = await scheduleBetween(nyse(), fromMs, toMs);
    expect(sched).toHaveLength(7);
    const opens = sched.filter((s) => s.isOpen);
    expect(opens).toHaveLength(5);   // 5 weekdays
    const sat = sched.find((s) => s.date === '2026-05-16');
    expect(sat?.isOpen).toBe(false);
    expect(sat?.openMs).toBeNull();
  });
});
