// Live EODHD Exchange-Details HolidayProvider.
//
// Source: EODHD `/exchange-details/{exch}` (hours + holidays), reached through the
// market-data-service eodhd-client's metered `exchangeDetails(code)` method (Task 13).
// This is the live US holiday source that slots AHEAD of the baked-in static fallback
// (CLAUDE.md flags the static US table as needing manual 2028 dates). The static
// fallback stays as the cache's last resort.
//
// Dependency seam: @trader/shared-calendar must not depend on market-data-service, so
// the EODHD lookup is injected as a structural `ExchangeDetailsClient` (just the one
// `exchangeDetails` method) — exactly how NyseIcalProvider/UkGovBankHolidayProvider
// inject `fetch`. The market-data-service wiring passes its real `getEodhdClient()`,
// which satisfies the interface verbatim.
//
// Outage handling: `exchangeDetails` returns **null** on budget exhaustion / error
// (never throws) — it deliberately distinguishes an outage from a holiday-free year.
// This provider turns that null into a throw so HolidayCache moves to the next layer
// (the optional chained `next` provider, then the cache's static fallback) rather than
// caching an empty table as authoritative. A successful EODHD read with zero holidays
// is trusted as-is (source 'eodhd').

import type { HolidayTable, HalfDay, Market } from '../calendar.ts';
import type { HolidayProvider } from '../holiday-cache.ts';

// One holiday from EODHD Exchange-Details. Mirrors `EodhdExchangeHoliday` exported by
// services/market-data-service eodhd-client.ts (Task 13). `type` is passed through
// verbatim by the client (EODHD spells it variably), so we classify it here.
export interface ExchangeHolidayRow {
  readonly date: string;          // 'YYYY-MM-DD'
  readonly name: string;
  readonly type?: string;         // e.g. 'holiday' | 'half-day' (verbatim from EODHD)
}

// Subset of `EodhdExchangeDetails` (Task 13) this provider consumes. Structurally
// compatible with the full client return type — extra fields are ignored.
export interface ExchangeDetails {
  readonly code: string;
  readonly holidays: ExchangeHolidayRow[];
}

// The single capability this provider needs from the eodhd-client. Returns null on
// outage/error (must NOT be mistaken for "no holidays").
export interface ExchangeDetailsClient {
  exchangeDetails(code: string): Promise<ExchangeDetails | null>;
}

// EODHD exchange codes, keyed by our Market. EODHD uses 'US' for US equities and 'LSE'
// for the London Stock Exchange.
const EODHD_EXCHANGE_CODE: Record<Market, string> = { US: 'US', LSE: 'LSE' };

// EODHD Exchange-Details holidays carry no early-close time, so a half-day-typed entry
// is mapped to each market's conventional early close (matching the static fallback:
// US 13:00 ET, LSE 12:30 London).
const EARLY_CLOSE_LOCAL: Record<Market, string> = { US: '13:00', LSE: '12:30' };

// Classify an EODHD `type` string as an early close. EODHD spells it variably
// ('half-day', 'Half Day', 'early-close', …); match on substring, case-insensitively.
// Anything else (incl. the common 'holiday'/absent) is treated as a full closure.
function isEarlyClose(type: string | undefined): boolean {
  if (!type) return false;
  const t = type.toLowerCase();
  return t.includes('half') || t.includes('early');
}

export class EodhdExchangeHolidayProvider implements HolidayProvider {
  constructor(
    public readonly market: Market,
    private readonly client: ExchangeDetailsClient,
    // Optional next provider tried when EODHD is unavailable, BEFORE the cache's static
    // fallback — e.g. the NYSE iCal provider for US. Kept intact and chained rather than
    // replaced. Absent ⇒ throw straight through to the cache's static fallback.
    private readonly next?: HolidayProvider,
  ) {}

  async fetchYear(year: number): Promise<HolidayTable> {
    const code = EODHD_EXCHANGE_CODE[this.market];
    const details = await this.client.exchangeDetails(code);

    if (details === null) {
      // Outage / budget exhaustion — do NOT trust as a holiday-free year. Delegate to
      // the chained provider if present; otherwise throw so the cache drops to its
      // static fallback.
      if (this.next) {
        console.warn(`[EodhdExchangeHolidayProvider] EODHD unavailable for ${this.market} ${year} — delegating to ${this.next.constructor.name}`);
        return this.next.fetchYear(year);
      }
      throw new Error(`[EodhdExchangeHolidayProvider] EODHD exchange-details returned null for ${code} ${year} — outage or budget exhaustion`);
    }

    const fullClosures: string[] = [];
    const halfDays: HalfDay[] = [];
    for (const h of details.holidays) {
      // 'YYYY-MM-DD'.startsWith('YYYY-') keeps only the requested year.
      if (typeof h.date !== 'string' || !h.date.startsWith(`${year}-`)) continue;
      if (isEarlyClose(h.type)) {
        halfDays.push({ date: h.date, closeLocal: EARLY_CLOSE_LOCAL[this.market] });
      } else {
        fullClosures.push(h.date);
      }
    }
    // Sort for deterministic output (eases caching + diffs), matching the other providers.
    fullClosures.sort();
    halfDays.sort((a, b) => a.date.localeCompare(b.date));

    return {
      market: this.market,
      year,
      fullClosures,
      halfDays,
      fetchedAt: Date.now(),
      source: 'eodhd',
    };
  }
}
