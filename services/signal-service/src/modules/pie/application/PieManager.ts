import type { Logger } from '@trader/core';
import type { IPieRepository, PieTarget } from '../domain/Pie.ts';

// PieManager — the application seam that turns a resolved target-weight set into the strategy's
// active Pie. Called by GenerateSignals after the optimiser runs (for pie-managed strategies);
// returns the pieId so emitted signals can be stamped for attribution.
export class PieManager {
  constructor(private readonly repo: IPieRepository, private readonly logger: Logger) {}

  async syncFromWeights(strategyId: string, targets: PieTarget[], at: number, reason: string): Promise<string> {
    const pie = await this.repo.upsertActive(strategyId, targets, at, reason);
    this.logger.info({ pieId: pie.pieId, strategyId, holdings: targets.length, reason }, 'pie synced');
    return pie.pieId;
  }
}
