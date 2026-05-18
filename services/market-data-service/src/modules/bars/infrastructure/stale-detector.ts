import type { OHLCVBar } from '@trader/shared-types';

export interface StaleCheckResult {
  fresh: OHLCVBar[];
  stale: OHLCVBar[];
}

// Flags bars whose timestamp is more than `maxAgeMs` behind wall clock.
export class StaleDetector {
  constructor(private readonly maxAgeMs: number) {}

  check(bars: OHLCVBar[]): StaleCheckResult {
    const now = Date.now();
    const fresh: OHLCVBar[] = [];
    const stale: OHLCVBar[] = [];
    for (const bar of bars) {
      if (now - bar.timestamp > this.maxAgeMs) {
        stale.push(bar);
      } else {
        fresh.push(bar);
      }
    }
    return { fresh, stale };
  }
}
