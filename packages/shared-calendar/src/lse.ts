// London Stock Exchange calendar.
// Holiday data source: https://www.gov.uk/bank-holidays.json (england-and-wales),
// plus the LSE-specific half-day rule for Christmas Eve and New Year's Eve when
// those fall on a weekday — applied by UkGovBankHolidayProvider.
//
// Regular session: 08:00–16:30 Europe/London. Half-day closes (Christmas Eve, NYE)
// close at 12:30 local.

import type { ExchangeCalendar } from './calendar.ts';
import type { HolidayCache } from './holiday-cache.ts';

export function lseCalendar(holidays: HolidayCache): ExchangeCalendar {
  return {
    market: 'LSE',
    timezone: 'Europe/London',
    regularOpenLocal:  '08:00',
    regularCloseLocal: '16:30',
    postCloseGraceMs:  90 * 60_000,
    holidays,
  };
}
