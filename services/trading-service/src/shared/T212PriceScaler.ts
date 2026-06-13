import type { Logger } from '@trader/core';
import type { TickerIdentity } from '@trader/ticker-identity';

export interface PriceLookupForScaler {
    lastClose(id: TickerIdentity): Promise<number | null>;
}

// T212 reports each instrument's price in its native quote unit. Most LSE equities are
// pence-quoted (SUPR, SGLN, IUKD, …) so T212 returns pence; a minority (UCITS ETFs like
// VFEM) are pound-quoted. The listing alone can't tell us which — but only an LSE listing
// can ever be pence-quoted, so the pence-kill is gated on `market === 'LSE'` (a US listing
// is always USD, ratio ≈1, and must never be scaled). For an LSE name we cross-check against
// the stored OHLCV bar (already normalised to GBP at the provider boundary): a ratio around
// 100 means T212 reported pence; ratios near 1 mean it's already in the bar's units.
//
// Missing bar or non-positive price → pass through (no-op rather than fabricating a scaled
// value).
export async function scaleT212Quote(
    id: TickerIdentity,
    rawPrice: number,
    lookup: PriceLookupForScaler,
    logger?: Logger,
): Promise<number> {
    if (rawPrice <= 0) return rawPrice;
    // Pence only ever occurs on LSE listings; a US (USD) quote is never scaled. Keying on the
    // market field replaces the old `l_EQ` suffix regex.
    if (id.market !== 'LSE') return rawPrice;
    const bar = await lookup.lastClose(id);
    if (!bar || bar <= 0) return rawPrice;
    const ratio = rawPrice / bar;
    if (ratio > 50 && ratio < 200) {
        if (logger) {
            logger.info({ symbol: id.symbol, market: id.market, rawPrice, bar, ratio },
                't212-price-scaler: pence detected — scaling /100');
        }
        return rawPrice / 100;
    }
    return rawPrice;
}
