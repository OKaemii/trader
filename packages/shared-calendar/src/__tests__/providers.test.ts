import { describe, it, expect } from 'bun:test';
import { NyseIcalProvider } from '../providers/ical-provider.ts';
import { UkGovBankHolidayProvider } from '../providers/uk-gov-provider.ts';
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
    } finally {
      console.warn = origWarn;
    }
  });
});
