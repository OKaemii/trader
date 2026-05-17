// NYSE / Nasdaq US-equities calendar.
// Holiday data source: https://www.nyse.com/publicdocs/Holidays_and_Hours.ics
// (Resolved at runtime by NyseIcalProvider — see providers/ical-provider.ts.)
//
// Regular session: 09:30–16:00 America/New_York. Half-day closes (Black Friday,
// Christmas Eve, day before July 4 when observed) close at 13:00 local; provider
// extracts the early-close time from the iCal DESCRIPTION field.
//
// Post-close grace: 90min. Empirical Yahoo EOD print window for `/chart` 5m bars —
// the late EOD bar typically lands within 30–60min of the close; 90min is the
// safety buffer.

import type { ExchangeCalendar } from './calendar.ts';
import type { HolidayCache } from './holiday-cache.ts';

export function nyseCalendar(holidays: HolidayCache): ExchangeCalendar {
  return {
    market: 'US',
    timezone: 'America/New_York',
    regularOpenLocal:  '09:30',
    regularCloseLocal: '16:00',
    postCloseGraceMs:  90 * 60_000,
    holidays,
  };
}
