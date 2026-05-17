// LSE HolidayProvider backed by UK Gov bank-holidays JSON.
//
// Source: https://www.gov.uk/bank-holidays.json
// Official UK Government API. Free, no auth, machine-readable. Returns three divisions:
// 'england-and-wales', 'scotland', 'northern-ireland'. LSE closes on England-and-Wales
// bank holidays specifically — that's our division.
//
// LSE additionally has half-day closes on Christmas Eve and New Year's Eve when those
// dates fall on a weekday. These are NOT in the gov.uk feed (they're not bank holidays);
// we add them by rule. Half-day close is 12:30 London local.

import type { HolidayTable, HalfDay } from '../calendar.ts';
import type { HolidayProvider } from '../holiday-cache.ts';

export const UK_GOV_URL = 'https://www.gov.uk/bank-holidays.json';

interface UkGovEvent {
  title: string;
  date: string;     // 'YYYY-MM-DD'
  notes?: string;
  bunting?: boolean;
}

interface UkGovResponse {
  'england-and-wales': { division: string; events: UkGovEvent[] };
  'scotland'?:          { division: string; events: UkGovEvent[] };
  'northern-ireland'?:  { division: string; events: UkGovEvent[] };
}

const LSE_HALF_DAY_CLOSE = '12:30';

export class UkGovBankHolidayProvider implements HolidayProvider {
  readonly market = 'LSE' as const;

  constructor(
    private readonly url: string = UK_GOV_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchYear(year: number): Promise<HolidayTable> {
    const res = await this.fetchImpl(this.url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`[UkGovBankHolidayProvider] HTTP ${res.status} from ${this.url}`);
    const body = await res.json() as UkGovResponse;

    if (!body['england-and-wales'] || !Array.isArray(body['england-and-wales'].events)) {
      throw new Error('[UkGovBankHolidayProvider] response missing england-and-wales.events — feed shape may have changed');
    }

    const yearEvents = body['england-and-wales'].events
      .filter((e) => typeof e.date === 'string' && e.date.startsWith(`${year}-`));
    const fullClosures = yearEvents.map((e) => e.date).sort();

    // LSE half-day rule: Christmas Eve (12-24) and NYE (12-31) when on weekday AND
    // not already a full closure (e.g. when 12-25 lands on a Saturday, Christmas Day
    // is observed on Monday and there's no half-day on Friday).
    const halfDays: HalfDay[] = [];
    for (const dateStr of [`${year}-12-24`, `${year}-12-31`]) {
      const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
      if (dow !== 0 && dow !== 6 && !fullClosures.includes(dateStr)) {
        halfDays.push({ date: dateStr, closeLocal: LSE_HALF_DAY_CLOSE });
      }
    }

    return {
      market: 'LSE',
      year,
      fullClosures,
      halfDays,
      fetchedAt: Date.now(),
      source: 'gov-uk',
    };
  }
}
