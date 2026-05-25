import type { OHLCVBar } from '@trader/shared-types';

const ZSCORE_THRESHOLD = 10;
const ROLLING_WINDOW = 20;
// |revision.close - firstPrint.close| / firstPrint.close above this fraction emits a
// `bad_ticks{type:'revision_zscore_anomaly'}` for operator inspection (but the bar still
// goes into `valid` — it's a real revision Yahoo emitted, just suspicious).
const REVISION_DRIFT_THRESHOLD = 0.05;        // 5% absolute close drift

interface ValidationResult {
  valid: OHLCVBar[];
  invalid: Array<{ bar: OHLCVBar; reason: string }>;
  // Revisions whose close diverges materially from the first-print close. Persisted by
  // the caller to `bad_ticks` so the revisions dashboard can flag "this isn't a tick
  // correction — this looks like a different bar entirely."
  revisionAnomalies: Array<{ bar: OHLCVBar; firstPrintClose: number; driftFraction: number }>;
}

export interface ValidationContext {
  /**
   * Map keyed by `${ticker}|${observation_ts}` → close of the *earliest* stored revision
   * for that (ticker, observation_ts). Tells the validator:
   *   1. Whether an incoming bar is a first-print (key absent) or a revision (present).
   *   2. The reference close to compute revision drift against.
   * Callers should batch-fetch these via `fetchFirstPrintCloses` from persist-bars.ts.
   * Omit the map (or pass empty) for legacy / non-bi-temporal call paths — every bar is
   * treated as a first-print.
   */
  firstPrintCloseByKey?: Map<string, number>;
}

/**
 * Stateless-ish bar validator. Holds a per-ticker rolling window of first-print
 * closes (revisions are explicitly NOT injected into this window — they'd poison
 * the rolling mean / stddev and distort z-score gating for genuinely new bars).
 *
 * Revisions still get OHLC sanity + z-score-against-window checks (we don't want to
 * silently accept a revised close of -1), but their close is checked against the
 * rolling mean built from prior first-prints rather than allowed to modify it.
 *
 * See agent-docs/plans/point-in-time-bar-history.md §Validator first-print isolation.
 */
export class BarValidator {
  private priceHistory: Map<string, number[]> = new Map();

  validate(bars: OHLCVBar[], ctx: ValidationContext = {}): ValidationResult {
    const valid: OHLCVBar[] = [];
    const invalid: Array<{ bar: OHLCVBar; reason: string }> = [];
    const revisionAnomalies: ValidationResult['revisionAnomalies'] = [];
    const firstPrints = ctx.firstPrintCloseByKey;

    for (const bar of bars) {
      const key = `${bar.ticker}|${bar.observation_ts}`;
      const priorFirstPrintClose = firstPrints?.get(key);
      const isRevision = priorFirstPrintClose !== undefined;

      const reason = this.checkBar(bar);
      if (reason) {
        invalid.push({ bar, reason });
        continue;
      }
      valid.push(bar);

      if (isRevision) {
        // Revisions never update the rolling window — they'd let a corrected bar
        // re-weight subsequent z-scores as if it were a fresh observation.
        const drift = Math.abs(bar.close - priorFirstPrintClose) / priorFirstPrintClose;
        if (drift > REVISION_DRIFT_THRESHOLD) {
          revisionAnomalies.push({ bar, firstPrintClose: priorFirstPrintClose, driftFraction: drift });
        }
      } else {
        // First-print: feeds the rolling window as before.
        this.updateHistory(bar);
      }
    }

    return { valid, invalid, revisionAnomalies };
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
