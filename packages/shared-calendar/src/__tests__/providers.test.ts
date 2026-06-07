import { describe, it, expect } from "vitest";
import { NyseIcalProvider } from '../providers/ical-provider.ts';
import { UkGovBankHolidayProvider } from '../providers/uk-gov-provider.ts';
import {
  EodhdExchangeHolidayProvider,
  type ExchangeDetails,
  type ExchangeDetailsClient,
} from '../providers/eodhd-exchange-provider.ts';
import type { HolidayProvider } from '../holiday-cache.ts';
import type { HolidayTable } from '../calendar.ts';
import { StaticFallbackProvider, STATIC_FALLBACK } from '../providers/static-fallback.ts';

// Captured NYSE iCal fixture covering 2026 holidays + half-days. Matches the real
// feed's shape (we tested parser separately; here we test the provider extraction).
const NYSE_FIXTURE_2026 = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//NYSE//Holidays//EN',
  'BEGIN:VEVENT',
  'SUMMARY:New Year\'s Day',
  'DTSTART;VALUE=DATE:20260101',
  'DESCRIPTION:NYSE will be closed.',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Christmas Day',
  'DTSTART;VALUE=DATE:20261225',
  'DESCRIPTION:NYSE will be closed.',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Black Friday',
  'DTSTART;VALUE=DATE:20261127',
  'DESCRIPTION:NYSE will close early at 1:00 PM ET.',
  'END:VEVENT',
  // Out-of-year event — should be filtered out.
  'BEGIN:VEVENT',
  'SUMMARY:Future Closure',
  'DTSTART;VALUE=DATE:20270101',
  'DESCRIPTION:Closed.',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function stubFetch(response: { ok: boolean; status?: number; text?: string; json?: any }): typeof fetch {
  return (async () => new Response(
    response.text ?? (response.json ? JSON.stringify(response.json) : ''),
    { status: response.status ?? (response.ok ? 200 : 500) },
  )) as typeof fetch;
}

describe('NyseIcalProvider', () => {
  it('parses full closures and half-days for the requested year only', async () => {
    const provider = new NyseIcalProvider('http://test', stubFetch({ ok: true, text: NYSE_FIXTURE_2026 }));
    const table = await provider.fetchYear(2026);
    expect(table.market).toBe('US');
    expect(table.year).toBe(2026);
    expect(table.source).toBe('ical');
    expect(table.fullClosures).toEqual(['2026-01-01', '2026-12-25']);
    expect(table.halfDays).toEqual([{ date: '2026-11-27', closeLocal: '13:00' }]);
    // Out-of-year event filtered out.
    expect(table.fullClosures).not.toContain('2027-01-01');
  });

  it('throws on HTTP error', async () => {
    const provider = new NyseIcalProvider('http://test', stubFetch({ ok: false, status: 503 }));
    expect(provider.fetchYear(2026)).rejects.toThrow('HTTP 503');
  });

  it('throws on malformed iCal with RRULE', async () => {
    const bad = ['BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260101', 'RRULE:FREQ=YEARLY', 'END:VEVENT'].join('\r\n');
    const provider = new NyseIcalProvider('http://test', stubFetch({ ok: true, text: bad }));
    expect(provider.fetchYear(2026)).rejects.toThrow('unsupported recurrence property');
  });
});

const UK_GOV_FIXTURE = {
  'england-and-wales': {
    division: 'england-and-wales',
    events: [
      { title: 'New Year’s Day', date: '2026-01-01', notes: '', bunting: true },
      { title: 'Good Friday',         date: '2026-04-03', notes: '', bunting: false },
      { title: 'Easter Monday',       date: '2026-04-06', notes: '', bunting: true },
      { title: 'Christmas Day',       date: '2026-12-25', notes: '', bunting: true },
      { title: 'Boxing Day',          date: '2026-12-28', notes: 'Substitute day', bunting: true },
      // Out-of-year event — filtered.
      { title: 'New Year’s Day 2027', date: '2027-01-01', notes: '', bunting: true },
    ],
  },
  scotland: { division: 'scotland', events: [] },
  'northern-ireland': { division: 'northern-ireland', events: [] },
};

describe('UkGovBankHolidayProvider', () => {
  it('extracts england-and-wales events for the requested year', async () => {
    const provider = new UkGovBankHolidayProvider('http://test', stubFetch({ ok: true, json: UK_GOV_FIXTURE }));
    const table = await provider.fetchYear(2026);
    expect(table.market).toBe('LSE');
    expect(table.source).toBe('gov-uk');
    expect(table.fullClosures).toEqual([
      '2026-01-01', '2026-04-03', '2026-04-06', '2026-12-25', '2026-12-28',
    ]);
  });

  it('adds Christmas Eve + NYE half-days when they fall on weekdays', async () => {
    const provider = new UkGovBankHolidayProvider('http://test', stubFetch({ ok: true, json: UK_GOV_FIXTURE }));
    const table = await provider.fetchYear(2026);
    // 2026-12-24 is Thursday, 2026-12-31 is Thursday — both add as half-days.
    const xmasEve = table.halfDays.find((h) => h.date === '2026-12-24');
    const nye     = table.halfDays.find((h) => h.date === '2026-12-31');
    expect(xmasEve).toEqual({ date: '2026-12-24', closeLocal: '12:30' });
    expect(nye).toEqual({ date: '2026-12-31', closeLocal: '12:30' });
  });

  it('skips half-day rule when Christmas Eve falls on a weekend', async () => {
    // 2027-12-24 is Friday — so still a half-day. Pick a year where it lands on Saturday.
    // 2022-12-24 was a Saturday.
    const fixture = {
      'england-and-wales': { division: 'e-w', events: [
        { title: 'Christmas Day (substitute)', date: '2022-12-27', notes: '', bunting: true },
      ]},
    };
    const provider = new UkGovBankHolidayProvider('http://test', stubFetch({ ok: true, json: fixture }));
    const table = await provider.fetchYear(2022);
    expect(table.halfDays.find((h) => h.date === '2022-12-24')).toBeUndefined();
  });

  it('skips half-day rule when the date is already a full closure', async () => {
    const fixture = {
      'england-and-wales': { division: 'e-w', events: [
        { title: 'Christmas Eve (special)', date: '2026-12-24', notes: '', bunting: false },
      ]},
    };
    const provider = new UkGovBankHolidayProvider('http://test', stubFetch({ ok: true, json: fixture }));
    const table = await provider.fetchYear(2026);
    expect(table.fullClosures).toContain('2026-12-24');
    expect(table.halfDays.find((h) => h.date === '2026-12-24')).toBeUndefined();
  });

  it('throws on missing england-and-wales key (shape-change canary)', async () => {
    const provider = new UkGovBankHolidayProvider('http://test', stubFetch({ ok: true, json: { scotland: { events: [] } } }));
    expect(provider.fetchYear(2026)).rejects.toThrow('feed shape may have changed');
  });

  it('throws on HTTP error', async () => {
    const provider = new UkGovBankHolidayProvider('http://test', stubFetch({ ok: false, status: 502 }));
    expect(provider.fetchYear(2026)).rejects.toThrow('HTTP 502');
  });
});

describe('StaticFallbackProvider', () => {
  it('returns the baked-in 2026 US table with source=static-fallback', async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const provider = new StaticFallbackProvider('US');
      const table = await provider.fetchYear(2026);
      expect(table.source).toBe('static-fallback');
      expect(table.market).toBe('US');
      expect(table.fullClosures).toContain('2026-12-25');
      expect(table.halfDays.find((h) => h.date === '2026-11-27')).toBeDefined();
    } finally {
      console.warn = origWarn;
    }
  });

  it('returns the baked-in 2026 LSE table', async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const provider = new StaticFallbackProvider('LSE');
      const table = await provider.fetchYear(2026);
      expect(table.fullClosures).toContain('2026-04-03');   // Good Friday
      expect(table.fullClosures).toContain('2026-12-25');   // Christmas
    } finally {
      console.warn = origWarn;
    }
  });

  it('returns the baked-in 2027 US table with the weekend-shifted observances', async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const provider = new StaticFallbackProvider('US');
      const table = await provider.fetchYear(2027);
      expect(table.source).toBe('static-fallback');
      expect(table.year).toBe(2027);
      // 10 full closures incl. weekend-shifted Juneteenth (Fri 18th), Independence (Mon 5th), Christmas (Fri 24th).
      expect(table.fullClosures).toHaveLength(10);
      expect(table.fullClosures).toContain('2027-06-18');
      expect(table.fullClosures).toContain('2027-07-05');
      expect(table.fullClosures).toContain('2027-12-24');
      // Exactly one half-day in 2027 — the day after Thanksgiving. No July-3 / Dec-24 early close.
      expect(table.halfDays).toEqual([{ date: '2027-11-26', closeLocal: '13:00' }]);
    } finally {
      console.warn = origWarn;
    }
  });

  it('returns the baked-in 2027 LSE table with substitute days + both half-days', async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const provider = new StaticFallbackProvider('LSE');
      const table = await provider.fetchYear(2027);
      expect(table.year).toBe(2027);
      // Christmas/Boxing shift to substitute days Mon 27th / Tue 28th.
      expect(table.fullClosures).toHaveLength(8);
      expect(table.fullClosures).toContain('2027-12-27');
      expect(table.fullClosures).toContain('2027-12-28');
      // Both half-days occur (24th and 31st are Fridays in 2027).
      expect(table.halfDays).toEqual([
        { date: '2027-12-24', closeLocal: '12:30' },
        { date: '2027-12-31', closeLocal: '12:30' },
      ]);
    } finally {
      console.warn = origWarn;
    }
  });

  it('throws when no baked-in table for the requested year', async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const provider = new StaticFallbackProvider('US');
      expect(provider.fetchYear(2099)).rejects.toThrow('no fallback table');
    } finally {
      console.warn = origWarn;
    }
  });

  it('STATIC_FALLBACK constant matches provider output', async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      expect(STATIC_FALLBACK.US[2026].fullClosures).toContain('2026-01-01');
      expect(STATIC_FALLBACK.LSE[2026].fullClosures).toContain('2026-04-03');
      // 2027 baked in too (US has no other runtime source — NYSE iCal is dead).
      expect(STATIC_FALLBACK.US[2027].fullClosures).toContain('2027-01-01');
      expect(STATIC_FALLBACK.LSE[2027].fullClosures).toContain('2027-03-26');
    } finally {
      console.warn = origWarn;
    }
  });
});

// A stub eodhd-client exposing only the `exchangeDetails` capability the provider needs.
class StubExchangeClient implements ExchangeDetailsClient {
  calls = 0;
  constructor(private readonly result: ExchangeDetails | null) {}
  async exchangeDetails(code: string): Promise<ExchangeDetails | null> {
    this.calls++;
    return this.result === null ? null : { ...this.result, code };
  }
}

// A minimal recorder for the chained `next` provider, so we can prove EODHD-outage
// delegation hits NYSE iCal before the cache's static fallback.
class RecordingProvider implements HolidayProvider {
  calls = 0;
  constructor(public readonly market: 'US' | 'LSE', private readonly table: HolidayTable) {}
  async fetchYear(_year: number): Promise<HolidayTable> {
    this.calls++;
    return this.table;
  }
}

const EODHD_US_2026: ExchangeDetails = {
  code: 'US',
  holidays: [
    { date: '2026-01-01', name: "New Year's Day", type: 'holiday' },
    { date: '2026-12-25', name: 'Christmas Day' },                 // no type ⇒ full closure
    { date: '2026-11-27', name: 'Black Friday', type: 'half-day' },// early close
    // Out-of-year row — filtered.
    { date: '2027-01-01', name: "New Year's Day", type: 'holiday' },
  ],
};

describe('EodhdExchangeHolidayProvider', () => {
  it('maps EODHD holidays into full closures + half-days for the requested year only', async () => {
    const client = new StubExchangeClient(EODHD_US_2026);
    const provider = new EodhdExchangeHolidayProvider('US', client);
    const table = await provider.fetchYear(2026);
    expect(table.market).toBe('US');
    expect(table.year).toBe(2026);
    expect(table.source).toBe('eodhd');
    // Full closures sorted; half-day ('half-day' type) split off; 2027 row filtered.
    expect(table.fullClosures).toEqual(['2026-01-01', '2026-12-25']);
    expect(table.halfDays).toEqual([{ date: '2026-11-27', closeLocal: '13:00' }]);
    expect(table.fullClosures).not.toContain('2027-01-01');
  });

  it('classifies early/half-close types case-insensitively and uses the LSE early close', async () => {
    const client = new StubExchangeClient({
      code: 'LSE',
      holidays: [
        { date: '2026-12-24', name: 'Christmas Eve', type: 'Half Day' },
        { date: '2026-12-31', name: "New Year's Eve", type: 'EARLY-CLOSE' },
        { date: '2026-12-25', name: 'Christmas Day', type: 'Holiday' },
      ],
    });
    const provider = new EodhdExchangeHolidayProvider('LSE', client);
    const table = await provider.fetchYear(2026);
    expect(table.fullClosures).toEqual(['2026-12-25']);
    expect(table.halfDays).toEqual([
      { date: '2026-12-24', closeLocal: '12:30' },
      { date: '2026-12-31', closeLocal: '12:30' },
    ]);
  });

  it('trusts a successful read with zero holidays (source=eodhd, not an outage)', async () => {
    const client = new StubExchangeClient({ code: 'US', holidays: [] });
    const provider = new EodhdExchangeHolidayProvider('US', client);
    const table = await provider.fetchYear(2026);
    expect(table.source).toBe('eodhd');
    expect(table.fullClosures).toEqual([]);
    expect(table.halfDays).toEqual([]);
  });

  it('throws on EODHD outage (null) when no chained provider is given', async () => {
    const client = new StubExchangeClient(null);
    const provider = new EodhdExchangeHolidayProvider('US', client);
    await expect(provider.fetchYear(2026)).rejects.toThrow('outage or budget exhaustion');
  });

  it('delegates to the chained provider on EODHD outage (NYSE iCal stays intact)', async () => {
    const nyseTable: HolidayTable = {
      market: 'US', year: 2026, fullClosures: ['2026-07-03'], halfDays: [],
      fetchedAt: Date.now(), source: 'ical',
    };
    const next = new RecordingProvider('US', nyseTable);
    const client = new StubExchangeClient(null);
    const provider = new EodhdExchangeHolidayProvider('US', client, next);
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const table = await provider.fetchYear(2026);
      expect(client.calls).toBe(1);          // EODHD tried first
      expect(next.calls).toBe(1);            // then delegated
      expect(table.source).toBe('ical');     // got the NYSE iCal table, ahead of static fallback
      expect(table.fullClosures).toEqual(['2026-07-03']);
    } finally {
      console.warn = origWarn;
    }
  });

  it('does not call the chained provider when EODHD succeeds', async () => {
    const next = new RecordingProvider('US', {
      market: 'US', year: 2026, fullClosures: [], halfDays: [], fetchedAt: 0, source: 'ical',
    });
    const client = new StubExchangeClient(EODHD_US_2026);
    const provider = new EodhdExchangeHolidayProvider('US', client, next);
    const table = await provider.fetchYear(2026);
    expect(table.source).toBe('eodhd');
    expect(next.calls).toBe(0);
  });
});
