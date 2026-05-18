import type { ISignalPublisher } from '../domain/ISignalPublisher.ts';
import type { TradeSignal } from '../domain/TradeSignal.ts';
import { xAdd } from '@trader/shared-redis';
import { REDIS_STREAMS } from '@trader/shared-types';
import type { RedisClientType } from 'redis';
import type { Logger } from '@trader/core';

const DEDUP_PREFIX = 'signals:trade:published:';
const DEDUP_TTL_SECONDS = 60 * 60;       // 1h covers the full signal lifecycle window

export class RedisSignalPublisher implements ISignalPublisher {
  constructor(
    private readonly redis: RedisClientType,
    private readonly logger?: Logger,
  ) {}

  // markExecuted fires from THREE paths today: PlaceOrderUseCase (optimistic submit),
  // FillsPoller (actual fill), and the dispatcher's existing-order branch (post-crash /
  // duplicate-claim resolution). Each used to xAdd to signals:trade independently,
  // landing 2-3 entries per signal on the stream — the notification batcher then
  // re-emitted the same pick 2-3x in its analysis email (visible to the user as "PYPL
  // appears twice at identical weights").
  //
  // Dedup is at the source rather than per-consumer so EVERY downstream (email, push,
  // future webhooks) sees exactly one entry per signal.id. SET ... NX EX is atomic:
  // first publish wins, subsequent ones short-circuit.
  async publish(signal: TradeSignal): Promise<void> {
    const dedupKey = `${DEDUP_PREFIX}${signal.id}`;
    const acquired = await this.redis.set(dedupKey, '1', { NX: true, EX: DEDUP_TTL_SECONDS });
    if (!acquired) {
      this.logger?.info({ signalId: signal.id, ticker: signal.ticker }, 'publish: dedup skip (already on signals:trade)');
      return;
    }
    await xAdd(this.redis, REDIS_STREAMS.TRADE_SIGNALS, signal);
  }
}
