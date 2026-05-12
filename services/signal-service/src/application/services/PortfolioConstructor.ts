import { solveLongOnly, type RankingInput } from './LongOnlyOptimiser.ts';

export interface PortfolioResult {
  weights: number[];
  factorExposures: Record<string, number>;
  stabilityWarnings: string[];
  uncertainty: 'low' | 'medium' | 'high';
}

const FACTOR_NAMES = ['momentum', 'reversal', 'low_vol', 'topology', 'residual_alpha'] as const;
const COND_NUM_THRESHOLD = 1000;
const WEIGHT_CHANGE_THRESHOLD = 0.10;  // 10% single-name step

/**
 * Wraps LongOnlyOptimiser with factor exposure decomposition and optimizer
 * stability guards (Section 30d+30e). Stateful: tracks previous weights to
 * detect large single-step weight jumps.
 */
export class PortfolioConstructor {
  // Previous weights keyed by sorted ticker list (stable identity for the universe)
  private readonly _prevWeights = new Map<string, number[]>();

  construct(
    input: RankingInput,
    factorAttributions: Record<string, Record<string, number>>,
  ): PortfolioResult {
    const weights = solveLongOnly(input);
    const { tickers, covariance } = input;
    const warnings: string[] = [];

    // 1. Condition number guard (diagonal proxy for shrunk Σ — full eigen decomp in Python)
    const condApprox = _diagConditionNumber(covariance);
    if (condApprox > COND_NUM_THRESHOLD) {
      warnings.push(
        `Covariance condition number ~${condApprox.toFixed(0)} exceeds ${COND_NUM_THRESHOLD} — increase shrinkage or reduce universe`,
      );
    }

    // 2. Weight change stability guard
    const universeKey = [...tickers].sort().join(',');
    const prev = this._prevWeights.get(universeKey);
    if (prev && prev.length === weights.length) {
      const maxChange = tickers.reduce((max, ticker, i) => {
        const prevIdx = prev[i];
        return Math.max(max, Math.abs(weights[i] - prevIdx));
      }, 0);
      if (maxChange > WEIGHT_CHANGE_THRESHOLD) {
        warnings.push(
          `Max single-name weight step ${(maxChange * 100).toFixed(1)}% exceeds ${WEIGHT_CHANGE_THRESHOLD * 100}% stability guard`,
        );
      }
    }
    this._prevWeights.set(universeKey, [...weights]);

    // 3. Factor exposure decomposition: portfolio_betas = w · B
    const factorExposures: Record<string, number> = {};
    for (const factor of FACTOR_NAMES) {
      factorExposures[factor] = weights.reduce((sum, w, i) => {
        const ticker = tickers[i];
        return sum + w * (factorAttributions[ticker]?.[factor] ?? 0);
      }, 0);
    }

    return {
      weights,
      factorExposures,
      stabilityWarnings: warnings,
      uncertainty: warnings.length > 0 ? 'high' : 'low',
    };
  }
}

function _diagConditionNumber(cov: number[][]): number {
  if (cov.length === 0) return 1;
  const diag = cov.map((row, i) => row[i] ?? 0);
  const max = Math.max(...diag);
  const positives = diag.filter((d) => d > 1e-12);
  if (positives.length === 0) return Infinity;
  return max / Math.min(...positives);
}
