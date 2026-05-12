import type { IRefreshTokenStore } from '../../domain/interfaces/IRefreshTokenStore.ts';
import { getRedisClient } from '@trader/shared-redis';
import { randomUUID } from 'node:crypto';

export class RedisRefreshTokenStore implements IRefreshTokenStore {
  async save(userId: string, token: string, ttlSeconds: number): Promise<void> {
    const redis = await getRedisClient();
    await redis.setEx(`refresh:${userId}:${randomUUID()}`, ttlSeconds, token);
  }
}
