import type { Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import type { BarHLC } from '../application/detect.ts';

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Latest unsuperseded bar for a ticker (high/low/close), used by the AlertWatcher to detect a
// level cross. Reads OHLCV_BARS directly the same way PriceLookup does — on the daily-default
// platform the most-recent bar is the day's bar, whose high/low bracket the session's range.
export class LatestBarReader {
    constructor(private readonly db: Db) {}

    async latest(ticker: string): Promise<BarHLC | null> {
        const doc = await this.db.collection(COLLECTIONS.OHLCV_BARS)
            .find({ ticker, is_superseded: false })
            .sort({ observation_ts: -1 })
            .limit(1)
            .next();
        if (!doc) return null;
        const high = num(doc.high), low = num(doc.low), close = num(doc.close);
        return high != null && low != null && close != null ? { high, low, close } : null;
    }
}
