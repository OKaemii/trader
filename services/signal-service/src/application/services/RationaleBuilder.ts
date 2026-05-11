import type { StrategyOutput, SignalRationale } from '@trader/shared-types';

export function buildStructuredRationale(
  ticker: string,
  features: StrategyOutput,
): SignalRationale | null {
  const attribution = features.factor_attributions[ticker];
  if (!attribution) return null;

  const score = features.composite_scores[ticker] ?? 0;
  const residualAlpha = attribution['residual_alpha'] ?? 0;
  const momentumContrib = attribution['momentum'] ?? 0;
  const reversalContrib = attribution['reversal'] ?? 0;
  const topoContrib = attribution['topology'] ?? 0;

  // Plain-English rationale must be grounded in the dominant factor, not raw TDA numerics.
  const dominantFactor =
    Math.abs(reversalContrib) > Math.abs(momentumContrib) ? 'mean-reversion' : 'relative momentum';

  const plain = score > 0
    ? `${ticker} ranks in the top quantile on ${dominantFactor} relative to its sector peers.`
    : `${ticker} is being reduced — it has dropped in cross-sectional rank.`;

  return {
    plain_english: plain,
    economic_mechanism: dominantFactor === 'mean-reversion'
      ? 'Short-term price reversion following crowded positioning (Khandani & Lo 2007 mechanism)'
      : 'Cross-sectional momentum from persistent relative performance',
    factor_exposures: attribution,
    residual_alpha: residualAlpha,
    topology_contribution: Math.abs(topoContrib) > 0.01
      ? `TDA added ${(topoContrib * 100).toFixed(1)}% to the composite score (β₁ cluster tension)`
      : 'TDA contribution below threshold — signal dominated by simpler factors',
    uncertainty: (features.regime_confidence ?? 1) < 0.5 ? 'high' : 'medium',
  };
}
