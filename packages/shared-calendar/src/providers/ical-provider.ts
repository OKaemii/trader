// NYSE iCal HolidayProvider.
//
// Source: https://www.nyse.com/publicdocs/Holidays_and_Hours.ics
// Updated by NYSE for the current year plus 2-3 forward years. No auth required.

import type { HolidayTable, HalfDay } from '../calendar.ts';
import type { HolidayProvider } from '../holiday-cache.ts';
import { parseIcal, icalDateToIso, icalDateYear, parseEarlyCloseFromDescription } from '../ical-parser.ts';

export const NYSE_ICAL_URL = 'https://www.nyse.com/publicdocs/Holidays_and_Hours.ics';

export class NyseIcalProvider implements HolidayProvider {
  readonly market = 'US' as const;

  constructor(
    private readonly url: string = NYSE_ICAL_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchYear(year: number): Promise<HolidayTable> {
    const res = await this.fetchImpl(this.url, { headers: { 'Accept': 'text/calendar' } });
    if (!res.ok) throw new Error(`[NyseIcalProvider] HTTP ${res.status} from ${this.url}`);
    const text = await res.text();
    const events = parseIcal(text);

    const fullClosures: string[] = [];
    const halfDays:     HalfDay[] = [];
    for (const ev of events) {
      if (icalDateYear(ev.dtStart) !== year) continue;
      const early = parseEarlyCloseFromDescription(ev.description);
      if (early) {
        halfDays.push({ date: icalDateToIso(ev.dtStart), closeLocal: early });
      } else {
        fullClosures.push(icalDateToIso(ev.dtStart));
      }
    }
    // Sort for deterministic output (eases caching + diffs).
    fullClosures.sort();
    halfDays.sort((a, b) => a.date.localeCompare(b.date));

    return {
      market: 'US',
      year,
      fullClosures,
      halfDays,
      fetchedAt: Date.now(),
      source: 'ical',
    };
  }
}
