// CorporateActionsProvider — the seam the store fetches dividends/splits through. Wraps the EODHD
// client's thin `dividends()`/`splits()` methods (Task 13) plus the T212→EODHD symbol resolution and
// the pence-at-the-boundary scaling, so the store stays free of EODHD/currency details and the unit
// tests inject a fake without an HTTP round-trip. Both methods take a `from` 'YYYY-MM-DD' cursor so
// the store can fetch only events newer than what it already holds (plan §I incremental sync); the
// underlying EODHD feed filters server-side by `from`, so a current ticker costs one near-empty call
// (and zero when the store decides it has nothing to fetch — see CorporateActionsStore).

import {
  getEodhdClient,
  toEodhdSymbol,
  eodhdCurrencyForExchange,
  type EodhdExchange,
} from '../../bars/infrastructure/providers/eodhd-client.ts';

// One dividend event in BASE units (pence already killed) — the store-facing shape.
export interface ProviderDividend {
  date: string;          // 'YYYY-MM-DD' ex-dividend date
  valuePerShare: number; // gross dividend per share, BASE units (GBP/USD)
  currency?: string;
}

// One split event — `ratio` raw, `factor` parsed (NaN = unparseable → don't auto-adjust).
export interface ProviderSplit {
  date: string;
  ratio: string;
  factor: number;
}

export interface CorporateActionsProvider {
  /** Dividends with ex-date strictly after `fromIso` (omit for full history), BASE units. */
  fetchDividends(t212Ticker: string, fromIso?: string): Promise<ProviderDividend[]>;
  /** Splits with effective-date strictly after `fromIso` (omit for full history). */
  fetchSplits(t212Ticker: string, fromIso?: string): Promise<ProviderSplit[]>;
}

// 'YYYY-MM-DD' + one day, as an ISO date. EODHD's `from` is inclusive, but our cursor is the last
// date we already stored, so we want events strictly after it — ask the feed from the next day.
function nextDayIso(isoDate: string): string {
  const ms = Date.parse(isoDate);
  if (!Number.isFinite(ms)) return isoDate;
  return new Date(ms + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export class EodhdCorporateActionsProvider implements CorporateActionsProvider {
  async fetchDividends(t212Ticker: string, fromIso?: string): Promise<ProviderDividend[]> {
    const eodhdSymbol = toEodhdSymbol(t212Ticker);
    const { priceScale } = currencyFor(eodhdSymbol);
    const from = fromIso ? nextDayIso(fromIso) : undefined;
    const events = await getEodhdClient().dividends(eodhdSymbol, from);
    return events.map((e) => ({
      date: e.date,
      // Scale at the boundary exactly like prices — LSE quotes (and so dividends) in pence; ×0.01
      // tags GBP. After this point a dividend value is GBP/USD, never pence, matching the daily close.
      valuePerShare: e.value * priceScale,
      ...(e.currency ? { currency: e.currency } : {}),
    }));
  }

  async fetchSplits(t212Ticker: string, fromIso?: string): Promise<ProviderSplit[]> {
    const eodhdSymbol = toEodhdSymbol(t212Ticker);
    const from = fromIso ? nextDayIso(fromIso) : undefined;
    const events = await getEodhdClient().splits(eodhdSymbol, from);
    // Splits carry no monetary value — the ratio/factor are unit-free, so no boundary scaling.
    return events.map((e) => ({ date: e.date, ratio: e.ratio, factor: e.factor }));
  }
}

// Exchange (and so pence scaling) is derivable from the resolved EODHD symbol suffix — same rule the
// daily-history fetch uses. `.LSE` → GBP/pence; everything else → USD (the curated universe is US+LSE).
function currencyFor(eodhdSymbol: string): { exchange: EodhdExchange; priceScale: number } {
  const exchange: EodhdExchange = eodhdSymbol.endsWith('.LSE') ? 'LSE' : 'US';
  return { exchange, priceScale: eodhdCurrencyForExchange(exchange).priceScale };
}
