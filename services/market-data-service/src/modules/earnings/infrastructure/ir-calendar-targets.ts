// Curated IR-calendar scrape targets for IrCalendarEarningsProvider (Pipeline B). Each entry maps a
// T212 ticker (the form the universe/scheduler passes) to the company's investor-relations / press
// pages that publish the next expected earnings date. The provider renders these through Firecrawl
// and parses the soonest future earnings date out of the rendered markdown.
//
// This is intentionally a PARTIAL, best-effort seed (the large-cap US names whose IR pages are stable
// and machine-readable). A ticker absent from this map is simply omitted by the provider — no guessed
// date (the degrade-to-empty contract). Operators extend it as coverage grows; a later card can swap
// in a per-name IR-URL store. Keying on the T212 ticker keeps it consistent with how the scheduler
// drives the provider; the store re-derives (symbol, market) when it writes the calendar doc.
//
// `name` is the short provenance label that flows into the calendar doc's `source`
// (`ir-calendar:<name>`); keep it the bare host so the read surfaces stay readable.

import type { IrTarget } from './IrCalendarEarningsProvider.ts';

export const IR_CALENDAR_TARGETS: Record<string, IrTarget[]> = {
    AAPL_US_EQ: [{ url: 'https://investor.apple.com/investor-relations/default.aspx', name: 'investor.apple.com' }],
    MSFT_US_EQ: [{ url: 'https://www.microsoft.com/en-us/investor/earnings/trended/income-statements.aspx', name: 'microsoft.com/investor' }],
    GOOGL_US_EQ: [{ url: 'https://abc.xyz/investor/', name: 'abc.xyz/investor' }],
    GOOG_US_EQ: [{ url: 'https://abc.xyz/investor/', name: 'abc.xyz/investor' }],
    AMZN_US_EQ: [{ url: 'https://ir.aboutamazon.com/quarterly-results/default.aspx', name: 'ir.aboutamazon.com' }],
    META_US_EQ: [{ url: 'https://investor.atmeta.com/investor-news/default.aspx', name: 'investor.atmeta.com' }],
    NVDA_US_EQ: [{ url: 'https://investor.nvidia.com/events-and-presentations/events-and-presentations/default.aspx', name: 'investor.nvidia.com' }],
    TSLA_US_EQ: [{ url: 'https://ir.tesla.com/', name: 'ir.tesla.com' }],
    JPM_US_EQ: [{ url: 'https://www.jpmorganchase.com/ir/quarterly-earnings', name: 'jpmorganchase.com/ir' }],
    V_US_EQ: [{ url: 'https://investor.visa.com/events-and-presentations/default.aspx', name: 'investor.visa.com' }],
};
