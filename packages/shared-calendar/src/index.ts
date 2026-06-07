export {
  type Market,
  type MarketState,
  type ExchangeCalendar,
  type HolidayTable,
  type HalfDay,
  marketStateOf,
  shouldPollMarket,
  partitionByMarket,
  nextOpen,
  nextClose,
  soonestNextOpen,
  expectedLatestBarMs,
  nextEodPollInstant,
  soonestEodPollInstant,
  scheduleBetween,
} from './calendar.ts';

// Calendar factories — take a HolidayCache and return an ExchangeCalendar bound to it.
// Factories rather than singletons so a single process can hold a single HolidayCache
// instance + two calendars without an init-order dance.
export { nyseCalendar } from './nyse.ts';
export { lseCalendar } from './lse.ts';

export { parseIcal, type IcalEvent } from './ical-parser.ts';

export { NyseIcalProvider } from './providers/ical-provider.ts';
export { UkGovBankHolidayProvider } from './providers/uk-gov-provider.ts';
export {
  EodhdExchangeHolidayProvider,
  type ExchangeDetailsClient,
  type ExchangeDetails,
  type ExchangeHolidayRow,
} from './providers/eodhd-exchange-provider.ts';
export { StaticFallbackProvider, STATIC_FALLBACK } from './providers/static-fallback.ts';

export { HolidayCache, type HolidaySourceHealth, type HolidayProvider } from './holiday-cache.ts';
