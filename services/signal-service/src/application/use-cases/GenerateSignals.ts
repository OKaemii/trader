import { TradeSignal, type Action } from '../../domain/entities/TradeSignal.ts';
import type { ISignalRepository } from '../../domain/interfaces/ISignalRepository.ts';
import type { ISignalPublisher } from '../../domain/interfaces/ISignalPublisher.ts';
import type { IPortfolioState } from '../../domain/interfaces/IPortfolioState.ts';
import type { StrategyOutput } from '@trader/shared-types';
import { solveLongOnly } from '../services/LongOnlyOptimiser.ts';
import { buildStructuredRationale } from '../services/RationaleBuilder.ts';
import { randomUUID } from 'node:crypto';

// Strategy policy — source from env/config in the composition root.
// Not a domain constant: it will vary by regime, strategy, and retraining cycle.
const MIN_ACTIONABLE_CONFIDENCE = parseFloat(process.env.MIN_ACTIONABLE_CONFIDENCE ?? '0.3');

export class GenerateSignalsUseCase {
  constructor(
    private readonly signalRepo: ISignalRepository,
    private readonly publisher: ISignalPublisher,
    private readonly portfolioState: IPortfolioState,
  ) {}

  async execute(features: StrategyOutput): Promise<TradeSignal[]> {
    const currentWeights = await this.portfolioState.currentWeights();

    const weights = solveLongOnly({
      scores: features.ticker_universe.map((t) => features.composite_scores[t] ?? 0),
      tickers: features.ticker_universe,
      sectors: features.ticker_universe.map((t) => features.sectors[t] ?? 'Unknown'),
      currentWeights: features.ticker_universe.map((t) => currentWeights[t] ?? 0),
      targetVol: parseFloat(process.env.VOL_TARGET ?? '0.10'),
      covariance: features.covariance_matrix,
    });

    const signals = features.ticker_universe
      .map((ticker, i): TradeSignal | null => {
        const w = weights[i];
        const currentW = currentWeights[ticker] ?? 0;
        if (w < 0.01 && currentW < 0.01) return null;

        const action: Action =
          w > currentW + 0.01 ? 'BUY' :
          w < currentW - 0.01 ? 'SELL' :   // SELL = reduce long, never short
          'HOLD';

        if (action === 'HOLD') return null;

        const rationale = buildStructuredRationale(ticker, features);
        if (!rationale) return null;

        try {
          return new TradeSignal({
            id: randomUUID(),
            timestamp: features.timestamp,
            ticker,
            action,
            confidence: Math.min(Math.abs(features.composite_scores[ticker] ?? 0) / 0.05, 1),
            targetWeight: w,
            rationale: JSON.stringify(rationale),
          });
        } catch { return null; }
      })
      .filter((s): s is TradeSignal => s !== null && s.isActionable(MIN_ACTIONABLE_CONFIDENCE));

    await Promise.all(signals.map((s) => this.signalRepo.save(s)));
    await Promise.all(signals.map((s) => this.publisher.publish(s)));
    return signals;
  }
}
