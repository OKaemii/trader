import type { Db } from 'mongodb';
import { getPgPool } from '@trader/shared-pg';
import { COLLECTIONS } from '@trader/shared-mongo';
import { Trading212TickerAdapter } from '@trader/ticker-identity';
import type { BarHLC } from '../application/detect.ts';

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function activeBackend(): 'mongo' | 'timescale' {
    return (process.env.BARS_BACKEND ?? 'mongo') === 'timescale' ? 'timescale' : 'mongo';
}

// Storage is keyed on the bare identity (symbol, market); split the T212 ticker at the boundary.
const tickerAdapter = new Trading212TickerAdapter();

// Latest unsuperseded bar for a ticker (high/low/close), used by the AlertWatcher to detect a
// level cross. Dispatches on BARS_BACKEND exactly like PriceLookup — the live cluster runs
// timescale, so a Mongo-only reader would read an empty store and the watcher would never fire.
// On the daily-default platform the most-recent bar is the day's bar, whose high/low bracket the
// session range.
export class LatestBarReader {
    constructor(private readonly db: Db) {}

    async latest(ticker: string): Promise<BarHLC | null> {
        return activeBackend() === 'timescale' ? this.latestPg(ticker) : this.latestMongo(ticker);
    }

    private async latestMongo(ticker: string): Promise<BarHLC | null> {
        const { symbol, market } = tickerAdapter.fromT212(ticker);
        const doc = await this.db.collection(COLLECTIONS.OHLCV_BARS)
            .find({ symbol, market, is_superseded: false })
            .sort({ observation_ts: -1 })
            .limit(1)
            .next();
        if (!doc) return null;
        const high = num(doc.high), low = num(doc.low), close = num(doc.close);
        return high != null && low != null && close != null ? { high, low, close } : null;
    }

    private async latestPg(ticker: string): Promise<BarHLC | null> {
        // Live path — partial-unique-index fast lane, same as PriceLookup._lastClosePg.
        const { symbol, market } = tickerAdapter.fromT212(ticker);
        const { rows } = await getPgPool().query<{ high: string; low: string; close: string }>(
            `SELECT high, low, close FROM bars
              WHERE symbol = $1 AND market = $2 AND is_superseded = FALSE
              ORDER BY observation_ts DESC LIMIT 1`,
            [symbol, market],
        );
        const r = rows[0];
        if (!r) return null;
        const high = num(Number(r.high)), low = num(Number(r.low)), close = num(Number(r.close));
        return high != null && low != null && close != null ? { high, low, close } : null;
    }
}
