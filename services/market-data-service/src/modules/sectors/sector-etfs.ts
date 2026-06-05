// The sector-rotation reference set: the 11 SPDR sector ETFs + SPY. These are tracked (daily bars
// backfilled + refreshed) but DELIBERATELY NOT added to the tradeable universe (instrument_registry)
// — they exist only to power the weekly sector-momentum heatmap, never to be traded by the
// long-only strategy.

const SECTOR_LABELS: Record<string, string> = {
    SPY:  'S&P 500',
    XLK:  'Technology',
    XLF:  'Financials',
    XLV:  'Health Care',
    XLY:  'Consumer Discretionary',
    XLI:  'Industrials',
    XLP:  'Consumer Staples',
    XLE:  'Energy',
    XLU:  'Utilities',
    XLB:  'Materials',
    XLRE: 'Real Estate',
    XLC:  'Communication Services',
};

const DEFAULT_TICKERS = Object.keys(SECTOR_LABELS).map((s) => `${s}_US_EQ`);

/** The configured sector-ETF ticker set (SECTOR_ETF_TICKERS env, comma-separated; default the 12). */
export function sectorEtfTickers(): string[] {
    const raw = process.env.SECTOR_ETF_TICKERS;
    if (!raw) return DEFAULT_TICKERS;
    const parsed = raw.split(',').map((t) => t.trim()).filter(Boolean);
    return parsed.length > 0 ? parsed : DEFAULT_TICKERS;
}

/** Human sector label for an ETF ticker (e.g. `XLK_US_EQ` → 'Technology'); falls back to the bare symbol. */
export function sectorLabel(ticker: string): string {
    const bare = ticker.replace(/_US_EQ$/i, '').toUpperCase();
    return SECTOR_LABELS[bare] ?? bare;
}
