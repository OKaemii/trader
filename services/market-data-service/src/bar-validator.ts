import type { OHLCVBar } from '@trader/shared-types';

const ZSCORE_THRESHOLD = 10;
const ROLLING_WINDOW = 20;

interface ValidationResult {
  valid: OHLCVBar[];
  invalid: Array<{ bar: OHLCVBar; reason: string }>;
}

export class BarValidator {
  private priceHistory: Map<string, number[]> = new Map();

  validate(bars: OHLCVBar[]): ValidationResult {
    const valid: OHLCVBar[] = [];
    const invalid: Array<{ bar: OHLCVBar; reason: string }> = [];

    for (const bar of bars) {
      const reason = this.checkBar(bar);
      if (reason) {
        invalid.push({ bar, reason });
      } else {
        valid.push(bar);
        this.updateHistory(bar);
      }
    }

    return { valid, invalid };
  }

  private checkBar(bar: OHLCVBar): string | null {
    if (bar.close <= 0) return 'non-positive close price';
    if (bar.open <= 0 || bar.high <= 0 || bar.low <= 0) return 'non-positive OHLC price';
    if (bar.high < bar.low) return 'inverted OHLC (high < low)';
    if (bar.volume < 0) return 'negative volume';
    if (bar.close > bar.high || bar.close < bar.low) return 'close outside high-low range';

    // Z-score check against rolling window
    const history = this.priceHistory.get(bar.ticker);
    if (history && history.length >= 5) {
      const mean = history.reduce((a, b) => a + b, 0) / history.length;
      const variance = history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length;
      const std = Math.sqrt(variance);
      if (std > 0) {
        const zscore = Math.abs((bar.close - mean) / std);
        if (zscore > ZSCORE_THRESHOLD) return `z-score ${zscore.toFixed(1)} > ${ZSCORE_THRESHOLD}σ`;
      }
    }

    return null;
  }

  private updateHistory(bar: OHLCVBar): void {
    const history = this.priceHistory.get(bar.ticker) ?? [];
    history.push(bar.close);
    if (history.length > ROLLING_WINDOW) history.shift();
    this.priceHistory.set(bar.ticker, history);
  }
}
