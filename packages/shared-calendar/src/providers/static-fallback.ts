// Tiny baked-in safety net used when both live providers AND the Mongo cache are
// unavailable. Carries the current year plus the next — the NYSE iCal provider is dead,
// so US closures have no other runtime source. Older years are unlikely to be queried
// (the cache walks back at most 7 days). Operators must extend this before year-end (see
// the design doc); a missing year degrades to an empty-closures stub, not an error.
//
// When this provider is read, log loudly: `source: 'static-fallback'` shows up on
// the portal in red, and operators see a console warn.

import type { HolidayTable, Market } from '../calendar.ts';
import type { HolidayProvider } from '../holiday-cache.ts';

export const STATIC_FALLBACK: Record<Market, Record<number, HolidayTable>> = {
  US: {
    2026: {
      market: 'US',
      year: 2026,
      fullClosures: [
        '2026-01-01',   // New Year's Day
        '2026-01-19',   // MLK Day
        '2026-02-16',   // Presidents Day
        '2026-04-03',   // Good Friday
        '2026-05-25',   // Memorial Day
        '2026-06-19',   // Juneteenth
        '2026-07-03',   // July 4 observed (4th is Saturday)
        '2026-09-07',   // Labor Day
        '2026-11-26',   // Thanksgiving
        '2026-12-25',   // Christmas
      ],
      halfDays: [
        { date: '2026-07-02', closeLocal: '13:00' },  // day before July 4 observed
        { date: '2026-11-27', closeLocal: '13:00' },  // Black Friday
        { date: '2026-12-24', closeLocal: '13:00' },  // Christmas Eve
      ],
      fetchedAt: 0,
      source: 'static-fallback',
    },
    2027: {
      market: 'US',
      year: 2027,
      fullClosures: [
        '2027-01-01',   // New Year's Day
        '2027-01-18',   // MLK Day
        '2027-02-15',   // Presidents Day
        '2027-03-26',   // Good Friday
        '2027-05-31',   // Memorial Day
        '2027-06-18',   // Juneteenth observed (19th is Saturday)
        '2027-07-05',   // Independence Day observed (4th is Sunday)
        '2027-09-06',   // Labor Day
        '2027-11-25',   // Thanksgiving
        '2027-12-24',   // Christmas observed (25th is Saturday)
      ],
      halfDays: [
        { date: '2027-11-26', closeLocal: '13:00' },  // day after Thanksgiving
        // No July-3 or Dec-24 early close in 2027: July 4 is a Sunday (full closure moves to
        // Mon Jul 5), and Dec 24 is itself the observed Christmas full closure (Dec 25 is a
        // Saturday). The single half-day above is intentional — do not "fill the gap".
      ],
      fetchedAt: 0,
      source: 'static-fallback',
    },
  },
  LSE: {
    2026: {
      market: 'LSE',
      year: 2026,
      fullClosures: [
        '2026-01-01',   // New Year's Day
        '2026-04-03',   // Good Friday
        '2026-04-06',   // Easter Monday
        '2026-05-04',   // Early May bank holiday
        '2026-05-25',   // Spring bank holiday
        '2026-08-31',   // Summer bank holiday
        '2026-12-25',   // Christmas Day
        '2026-12-28',   // Boxing Day (substitute, Boxing Day is Saturday)
      ],
      halfDays: [
        { date: '2026-12-24', closeLocal: '12:30' },  // Christmas Eve (Thursday in 2026)
        { date: '2026-12-31', closeLocal: '12:30' },  // NYE (Thursday in 2026)
      ],
      fetchedAt: 0,
      source: 'static-fallback',
    },
    2027: {
      market: 'LSE',
      year: 2027,
      fullClosures: [
        '2027-01-01',   // New Year's Day
        '2027-03-26',   // Good Friday
        '2027-03-29',   // Easter Monday
        '2027-05-03',   // Early May bank holiday
        '2027-05-31',   // Spring bank holiday
        '2027-08-30',   // Summer bank holiday
        '2027-12-27',   // Christmas Day (substitute, 25th is Saturday)
        '2027-12-28',   // Boxing Day (substitute, 26th is Sunday)
      ],
      halfDays: [
        { date: '2027-12-24', closeLocal: '12:30' },  // Christmas Eve (Friday in 2027)
        { date: '2027-12-31', closeLocal: '12:30' },  // NYE (Friday in 2027)
      ],
      fetchedAt: 0,
      source: 'static-fallback',
    },
  },
};

// Provider wrapper so the cache can treat it like any other source. Throws for
// unknown years rather than guessing — the cache will surface the failure.
export class StaticFallbackProvider implements HolidayProvider {
  constructor(public readonly market: Market) {}

  async fetchYear(year: number): Promise<HolidayTable> {
    const t = STATIC_FALLBACK[this.market]?.[year];
    if (!t) throw new Error(`[StaticFallbackProvider] no fallback table for ${this.market} ${year}`);
    console.warn(`[StaticFallbackProvider] using baked-in fallback for ${this.market} ${year} — live providers must be broken; investigate.`);
    return t;
  }
}
