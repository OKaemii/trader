import type { OHLCVBar } from '@trader/shared-types';

export interface GapReport {
  missingTickers: string[];
  gapFraction: number;   // 0–1: fraction of universe with no bar this cycle
}

export class GapDetector {
  constructor(
    private readonly expectedIntervalMs: number,
  ) {}

  check(expectedTickers: string[], received: OHLCVBar[]): GapReport {
    const receivedSet = new Set(received.map((b) => b.ticker));
    const missingTickers = expectedTickers.filter((t) => !receivedSet.has(t));
    const gapFraction = expectedTickers.length > 0
      ? missingTickers.length / expectedTickers.length
      : 0;
    return { missingTickers, gapFraction };
  }
}
