import type { ISignalRepository } from '../../domain/interfaces/ISignalRepository.ts';
import type { IPortfolioState } from '../../domain/interfaces/IPortfolioState.ts';
import type { IPriceLookup } from '../../domain/interfaces/IPriceLookup.ts';
import type { SignalProgressDTO } from '@trader/shared-types';

// Builds the enriched view served at /api/signals/progress. The "live" fields
// (currentPrice, currentWeight, ageMs) are computed on read — we deliberately
// do not denormalise them onto the persisted document, because they would go
// stale instantly and the cost of a single OHLCV/positions read is negligible.
export class GetSignalProgressUseCase {
  constructor(
    private readonly signalRepo: ISignalRepository,
    private readonly portfolioState: IPortfolioState,
    private readonly priceLookup: IPriceLookup,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async execute(limit: number): Promise<SignalProgressDTO[]> {
    const signals = await this.signalRepo.findRecent(limit);
    if (signals.length === 0) return [];

    const tickers = Array.from(new Set(signals.map((s) => s.ticker)));
    const [prices, weights] = await Promise.all([
      this.priceLookup.lastCloseMany(tickers),
      this.portfolioState.currentWeights(),
    ]);

    const nowMs = this.now();
    return signals.map((s): SignalProgressDTO => {
      const currentPrice = prices[s.ticker] ?? null;
      return {
        id: s.id,
        timestamp: s.timestamp,
        ticker: s.ticker,
        strategy_id: s.strategy_id,
        action: s.action,
        confidence: s.confidence,
        targetWeight: s.targetWeight,
        rationale: s.rationale,
        approved: s.approved,
        entryPrice: s.entryPrice,
        lifecycle: s.lifecycle,
        approvedAt: s.approvedAt,
        executedAt: s.executedAt,
        closedAt: s.closedAt,
        exitPrice: s.exitPrice,
        executedQuantity: s.executedQuantity,
        attempts: s.attempts,
        lastAttemptAt: s.lastAttemptAt,
        failureReason: s.failureReason,
        failureDetail: s.failureDetail,
        currentPrice,
        currentWeight: weights[s.ticker] ?? 0,
        pnlPct: s.pnlPct(currentPrice),
        ageMs: Math.max(0, nowMs - s.timestamp),
        lifecycleResolved: s.lifecycle,
      };
    });
  }
}
