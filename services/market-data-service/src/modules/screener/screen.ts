// Pure swing-screener scoring: one daily series → which technical signals fire + a score. Kept
// pure (no IO) so the screen is unit-tested independently of the bar store / universe. Signals:
//   near_52w_high   — close within `near52wHighPct` of the trailing 52-week high
//   breakout_50ma   — close crossed ABOVE the 50-day SMA this bar (fresh breakout)
//   unusual_volume  — today's volume ≥ `volSurgeMult` × the 20-day average
//   pullback_uptrend— in an uptrend (SMA50 > SMA200) and pulled back to near the 50-day SMA

import { sma, avgVolume, high52w, pctReturn } from '@trader/shared-indicators';
import type { OHLCVBar } from '@trader/shared-types';

export interface ScreenerThresholds {
    near52wHighPct: number;    // within this fraction below the 52w high (default 0.05 = 5%)
    volSurgeMult: number;      // today vol / 20-day ADV ≥ this (default 1.5)
    pullbackBandPct: number;   // |close − SMA50| / SMA50 ≤ this for a pullback (default 0.03)
    topN: number;              // keep the top-N by score (default 10)
}

export const DEFAULT_THRESHOLDS: ScreenerThresholds = {
    near52wHighPct: 0.05,
    volSurgeMult: 1.5,
    pullbackBandPct: 0.03,
    topN: 10,
};

export interface SwingScreenRow {
    ticker: string;
    close: number;
    pctFrom52wHigh: number;     // (close − 52wHigh) / 52wHigh, ≤ 0
    volSurge: number;           // today vol / 20-day ADV (0 if unknown)
    signals: string[];
    score: number;
}

export function screenTicker(ticker: string, dailyBars: OHLCVBar[], t: ScreenerThresholds): SwingScreenRow | null {
    const n = dailyBars.length;
    if (n < 50) return null;                       // need ≥ 50 bars for the 50-day SMA

    const closes = dailyBars.map((b) => b.close);
    const highs = dailyBars.map((b) => b.high);
    const vols = dailyBars.map((b) => b.volume);
    const close = closes[n - 1]!;

    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, 200);
    const s50 = sma50[n - 1];
    const s50prev = sma50[n - 2];
    const s200 = sma200[n - 1];
    const hi52 = high52w(highs);
    const adv = avgVolume(vols.slice(0, -1), 20);   // trailing avg EXCLUDING today, vs which today is "unusual"

    const pctFrom52wHigh = hi52 != null && hi52 > 0 ? pctReturn(hi52, close) : 0;
    const near52wHigh = hi52 != null && pctFrom52wHigh >= -t.near52wHighPct;
    const freshCross50 = s50 != null && s50prev != null && close > s50 && closes[n - 2]! <= s50prev;
    const volSurge = adv != null && adv > 0 ? vols[n - 1]! / adv : 0;
    const unusualVol = volSurge >= t.volSurgeMult;
    const uptrend = s50 != null && s200 != null && s50 > s200;
    const nearMA50 = s50 != null && Math.abs(close - s50) / s50 <= t.pullbackBandPct;
    const pullbackInUptrend = uptrend && nearMA50 && s50 != null && close >= s50;

    const signals: string[] = [];
    if (near52wHigh) signals.push('near_52w_high');
    if (freshCross50) signals.push('breakout_50ma');
    if (unusualVol) signals.push('unusual_volume');
    if (pullbackInUptrend) signals.push('pullback_uptrend');
    if (signals.length === 0) return null;         // only surface names with at least one signal

    let score = 0;
    if (near52wHigh) score += 1 + (1 + pctFrom52wHigh / t.near52wHighPct);   // closer to the high → higher
    if (freshCross50) score += 2;
    if (unusualVol) score += Math.min(3, volSurge);
    if (pullbackInUptrend) score += 1.5;

    return { ticker, close, pctFrom52wHigh, volSurge, signals, score };
}
