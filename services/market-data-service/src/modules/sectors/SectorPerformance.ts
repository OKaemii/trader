// Pure sector-performance math: daily bars → weekly % returns + trailing momentum. Kept pure so
// the heatmap numbers are unit-tested independently of the bar store.

import { aggregateBars } from '@trader/shared-bars';
import { pctReturn } from '@trader/shared-indicators';
import type { OHLCVBar } from '@trader/shared-types';

export interface SectorPerf {
    ticker: string;
    sector: string;
    weekReturns: number[];        // last `weeks` completed weekly % returns, oldest → newest
    latest: number | null;        // most recent completed week's return
    trailing4w: number | null;    // 4-week cumulative return
    trailing13w: number | null;   // 13-week (≈ quarter) cumulative return
}

export function computeSectorPerf(
    ticker: string,
    sector: string,
    dailyBars: OHLCVBar[],
    weeks: number,
): SectorPerf {
    const weekly = aggregateBars(dailyBars, 'weekly');
    const closes = weekly.map((b) => b.close);

    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) rets.push(pctReturn(closes[i - 1]!, closes[i]!));
    const weekReturns = rets.slice(-weeks);

    const trailing = (n: number): number | null =>
        closes.length >= n + 1 ? pctReturn(closes[closes.length - 1 - n]!, closes[closes.length - 1]!) : null;

    return {
        ticker,
        sector,
        weekReturns,
        latest: weekReturns.length > 0 ? weekReturns[weekReturns.length - 1]! : null,
        trailing4w: trailing(4),
        trailing13w: trailing(13),
    };
}
