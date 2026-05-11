import type { RedisClientType } from 'redis';
import type { ICache } from '../interfaces/ICache.ts';

export class RedisCacheAdapter<T> implements ICache<T> {
  constructor(
    private readonly redis: RedisClientType,
    private readonly namespace: string,
    private readonly ttlSeconds: number,
  ) {}

  private key(id: string): string { return `${this.namespace}:${id}`; }

  async get(id: string): Promise<T | null> {
    const raw = await this.redis.get(this.key(id));
    return raw ? JSON.parse(raw) as T : null;
  }

  async set(id: string, value: T): Promise<void> {
    await this.redis.setEx(this.key(id), this.ttlSeconds, JSON.stringify(value));
  }

  async invalidate(id: string): Promise<void> {
    await this.redis.del(this.key(id));
  }

  async invalidatePattern(pattern: string): Promise<void> {
    const keys: string[] = [];
    // SCAN not KEYS — non-blocking, cursor-based, safe under load
    for await (const k of this.redis.scanIterator({ MATCH: `${this.namespace}:${pattern}` })) {
      keys.push(k);
    }
    if (keys.length) await this.redis.del(keys);
  }

  async getOrLoad(id: string, loader: () => Promise<T | null>): Promise<T | null> {
    const cached = await this.get(id);
    if (cached !== null) return cached;
    const fresh = await loader();
    if (fresh !== null) await this.set(id, fresh);
    return fresh;
  }
}
