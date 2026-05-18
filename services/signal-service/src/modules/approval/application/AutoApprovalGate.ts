// AutoApprovalGate — if enabled (Redis flag), auto-approves every signal a generation
// cycle emits, with a cash pro-rate pass for BUYs.
//
// Behaviour when ON:
//   1. SELLs approved immediately — no cash required, frees future capital.
//   2. BUYs are pro-rated as a batch: if sum(targetWeight × totalNAV) > freeCash, every
//      BUY's targetWeight is multiplied by `freeCash / totalBuyNotional`. This preserves
//      the ratio between BUYs (and therefore the optimiser's sector cap and ranking
//      signal) — diverging from the backtest only by uniformly downscaling exposure,
//      which is the least-bad off-policy adaptation we can make without re-running the
//      optimiser. The scaled targetWeight is persisted so trading-service sizes correctly.
//
// Failure modes:
//   - trading-service /internal/trading/cash unreachable → log + skip BUYs this cycle.
//     SELLs still approve. Next generation cycle retries.
//   - freeCash ≤ 0 → skip BUYs. SELLs still approve.
//   - In paper mode trading-service cash returns {free: 0, total: 0} → ratio of 0 →
//     BUYs are scaled to 0 and effectively skipped (auto-approve is a no-op for BUYs in
//     paper). This is intentional: paper mode has no real cash to size against.

import type { RedisClientType } from 'redis';
import type { Logger } from '@trader/core';
import type { TradingServiceClient } from '@trader/contracts';
import type { TradeSignal } from '../../signals/domain/TradeSignal.ts';
import type { ISignalRepository } from '../../signals/domain/ISignalRepository.ts';
import type { ApproveSignalUseCase } from './ApproveSignal.ts';

const REDIS_KEY = 'signal:auto_approve';

export class AutoApprovalGate {
  constructor(
    private readonly redis: Pick<RedisClientType, 'get' | 'set' | 'del'>,
    private readonly signalRepo: ISignalRepository,
    private readonly approveSignal: ApproveSignalUseCase,
    private readonly trading: TradingServiceClient,
    private readonly logger: Logger,
  ) {}

  async isEnabled(): Promise<boolean> {
    return !!(await this.redis.get(REDIS_KEY));
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) await this.redis.set(REDIS_KEY, '1');
    else         await this.redis.del(REDIS_KEY);
  }

  /** Process a freshly generated batch. Caller awaits if it cares about completion. */
  async process(signals: TradeSignal[]): Promise<{ approved: number; scaled: number; skipped: number }> {
    if (!(await this.isEnabled())) return { approved: 0, scaled: 0, skipped: 0 };
    if (signals.length === 0)      return { approved: 0, scaled: 0, skipped: 0 };

    const sells = signals.filter((s) => s.action === 'SELL');
    const buys  = signals.filter((s) => s.action === 'BUY');

    let approved = 0;
    let scaled   = 0;
    let skipped  = 0;

    // 1. SELLs first — no cash gate
    for (const s of sells) {
      try {
        await this.approveSignal.execute(s.id);
        approved++;
      } catch (err) {
        this.logger.warn({ err, signalId: s.id }, 'SELL approve failed');
        skipped++;
      }
    }

    if (buys.length === 0) return { approved, scaled, skipped };

    // 2. Fetch cash for the pro-rate. Both free + total are Money in GBP.
    let cash: { freeGBP: number; totalGBP: number } | null = null;
    try {
      const res = await this.trading.getCash();
      if (res.free.currency === 'GBP' && res.total.currency === 'GBP') {
        cash = { freeGBP: res.free.amount, totalGBP: res.total.amount };
      } else {
        this.logger.warn({ free: res.free.currency, total: res.total.currency },
          'cash response not GBP-denominated, skipping BUYs');
      }
    } catch (err) {
      this.logger.warn({ err }, 'cash fetch failed, skipping BUY auto-approve');
    }
    if (!cash || cash.freeGBP <= 0 || cash.totalGBP <= 0) {
      this.logger.warn({ free: cash?.freeGBP, total: cash?.totalGBP, buys: buys.length },
        'no free cash — skipping BUYs');
      return { approved, scaled, skipped: skipped + buys.length };
    }

    // 3. Total BUY notional and scale (all in GBP — targetWeight is dimensionless).
    const totalBuyWeight    = buys.reduce((acc, s) => acc + s.targetWeight, 0);
    const totalBuyNotional  = totalBuyWeight * cash.totalGBP;
    const scale = totalBuyNotional > cash.freeGBP ? cash.freeGBP / totalBuyNotional : 1.0;

    if (scale < 1.0) {
      this.logger.info({ buys: buys.length, notional: totalBuyNotional, free: cash.freeGBP, scale },
        'pro-rating BUYs');
    }

    // 4. Persist scaled weight + approve
    for (const s of buys) {
      try {
        if (scale < 1.0) {
          const newWeight = s.targetWeight * scale;
          await this.signalRepo.setTargetWeight(s.id, newWeight);
          scaled++;
        }
        await this.approveSignal.execute(s.id);
        approved++;
      } catch (err) {
        this.logger.warn({ err, signalId: s.id }, 'BUY approve failed');
        skipped++;
      }
    }

    return { approved, scaled, skipped };
  }
}
