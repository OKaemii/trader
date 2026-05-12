// Redis-backed circuit breaker — state persists across pod restarts.
// In-memory fallback is NOT acceptable: a pod restart must not re-open a tripped breaker.

import type { RedisClientType } from 'redis';

const KEY_OPEN   = 'risk:circuit:open';
const KEY_REASON = 'risk:circuit:reason';

export class CircuitBreakerRedis {
  constructor(private readonly redis: RedisClientType) {}

  async isOpen(): Promise<{ open: boolean; reason: string | null }> {
    const [open, reason] = await Promise.all([
      this.redis.get(KEY_OPEN),
      this.redis.get(KEY_REASON),
    ]);
    return { open: open === '1', reason: reason ?? null };
  }

  async trip(reason: string): Promise<void> {
    await Promise.all([
      this.redis.set(KEY_OPEN,   '1'),
      this.redis.set(KEY_REASON, reason),
    ]);
  }

  async reset(): Promise<void> {
    await Promise.all([
      this.redis.del(KEY_OPEN),
      this.redis.del(KEY_REASON),
    ]);
  }
}
