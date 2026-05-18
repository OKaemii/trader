import type { Logger } from '@trader/core';

export interface PriceLookupForScaler {
    lastClose(ticker: string): Promise<number | null>;
}

// T212 reports each instrument's price in its native quote unit. Most LSE equities are
// pence-quoted (`SUPRl_EQ`, `SGLNl_EQ`, `IUKDl_EQ`, …) so T212 returns pence; a minority
// (UCITS ETFs like `VFEMl_EQ`) are pound-quoted. The `l_EQ` suffix alone can't tell us
// which. Instead we cross-check against the stored OHLCV bar, which is already normalised
// to GBP at the Yahoo boundary (`normaliseYahooCurrency`). A ratio around 100 means T212
// reported pence; ratios near 1 mean it's already in the same units as the bar.
//
// USD tickers pass through unchanged because their stored bar is in USD and the ratio is
// ≈1. Missing bar or non-positive price → pass through (no-op rather than fabricating a
// scaled value).
export async function scaleT212Quote(
    ticker: string,
    rawPrice: number,
    lookup: PriceLookupForScaler,
    logger?: Logger,
): Promise<number> {
    if (rawPrice <= 0) return rawPrice;
    const bar = await lookup.lastClose(ticker);
    if (!bar || bar <= 0) return rawPrice;
    const ratio = rawPrice / bar;
    if (ratio > 50 && ratio < 200) {
        if (logger) {
            logger.info({ ticker, rawPrice, bar, ratio }, 't212-price-scaler: pence detected — scaling /100');
        }
        return rawPrice / 100;
    }
    return rawPrice;
}
