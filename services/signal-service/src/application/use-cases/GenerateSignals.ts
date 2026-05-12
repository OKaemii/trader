import { TradeSignal, type Action } from '../../domain/entities/TradeSignal.ts';
import type { ISignalRepository } from '../../domain/interfaces/ISignalRepository.ts';
import type { ISignalPublisher } from '../../domain/interfaces/ISignalPublisher.ts';
import type { IPortfolioState } from '../../domain/interfaces/IPortfolioState.ts';
import type { IPriceLookup } from '../../domain/interfaces/IPriceLookup.ts';
import type { StrategyOutput } from '@trader/shared-types';
import { buildStructuredRationale } from '../services/RationaleBuilder.ts';
import { PortfolioConstructor } from '../services/PortfolioConstructor.ts';
import type { RiskEngine } from '../services/RiskEngine.ts';
import type { StrategyDecayMonitor } from '../services/StrategyDecayMonitor.ts';
import { randomUUID } from 'node:crypto';

const MIN_ACTIONABLE_CONFIDENCE = parseFloat(process.env.MIN_ACTIONABLE_CONFIDENCE ?? '0.3');

export class GenerateSignalsUseCase {
  constructor(
    private readonly signalRepo: ISignalRepository,
    private readonly publisher: ISignalPublisher,
    private readonly portfolioState: IPortfolioState,
    private readonly riskEngine: RiskEngine,
    private readonly portfolioConstructor: PortfolioConstructor = new PortfolioConstructor(),
    private readonly decayMonitor?: StrategyDecayMonitor,
    private readonly priceLookup?: IPriceLookup,
  ) {}

  async execute(features: StrategyOutput): Promise<TradeSignal[]> {
    const { allowed, reason } = await this.riskEngine.canTrade();
    if (!allowed) {
      console.warn(`[GenerateSignals] circuit open — ${reason}`);
      return [];
    }

    // Strategy decay check: runs after every rebalance cycle (Section 28)
    let decayMultiplier = 1.0;
    if (this.decayMonitor) {
      const health = await this.decayMonitor.run();
      if (health === 'suspended') {
        console.warn('[GenerateSignals] strategy suspended by decay monitor — no new signals');
        return [];
      }
      if (health === 'degraded') {
        decayMultiplier = 0.25;
        console.warn('[GenerateSignals] strategy degraded — reducing position size to 25%');
      }
    }

    const currentWeights = await this.portfolioState.currentWeights();

    const { weights: rawWeights, stabilityWarnings, uncertainty } =
      this.portfolioConstructor.construct(
        {
          scores: features.ticker_universe.map((t) => features.composite_scores[t] ?? 0),
          tickers: features.ticker_universe,
          sectors: features.ticker_universe.map((t) => features.sectors[t] ?? 'Unknown'),
          currentWeights: features.ticker_universe.map((t) => currentWeights[t] ?? 0),
          targetVol: parseFloat(process.env.VOL_TARGET ?? '0.10'),
          covariance: features.covariance_matrix,
        },
        features.factor_attributions ?? {},
      );

    if (stabilityWarnings.length > 0) {
      for (const w of stabilityWarnings) console.warn(`[PortfolioConstructor] ${w}`);
    }

    const weights = this.riskEngine.applyRegimeScaling(
      rawWeights,
      (features.position_size_multiplier ?? 1.0) * decayMultiplier,
    );

    const decayFactor = this.riskEngine.confidenceDecayFactor();

    // Look up last close for every universe ticker in one round-trip — used as entryPrice
    // when emitting BUY/SELL signals. Optional dependency: tests can omit priceLookup.
    const lastCloses = this.priceLookup
      ? await this.priceLookup.lastCloseMany(features.ticker_universe)
      : {};

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

        const rationale = buildStructuredRationale(ticker, features, uncertainty);
        if (!rationale) return null;

        try {
          const entry = lastCloses[ticker];
          return new TradeSignal({
            id: randomUUID(),
            timestamp: features.timestamp,
            ticker,
            strategy_id: features.strategy_id,
            action,
            confidence: Math.min(Math.abs(features.composite_scores[ticker] ?? 0) / 0.05, 1) * decayFactor,
            targetWeight: w,
            rationale: JSON.stringify(rationale),
            entryPrice: entry && entry > 0 ? entry : undefined,
            lifecycle: 'pending',
          });
        } catch { return null; }
      })
      .filter((s): s is TradeSignal => s !== null && s.isActionable(MIN_ACTIONABLE_CONFIDENCE));

    await Promise.all(signals.map((s) => this.signalRepo.save(s)));
    await Promise.all(signals.map((s) => this.publisher.publish(s)));
    return signals;
  }
}
