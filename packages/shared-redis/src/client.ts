import { createClient, type RedisClientType } from 'redis';

let _client: RedisClientType | null = null;

export async function getRedisClient(): Promise<RedisClientType> {
  if (_client) return _client;
  _client = createClient({ url: process.env.REDIS_URL ?? 'redis://redis:6379' }) as RedisClientType;
  _client.on('error', (err) => console.error('[redis]', err));
  await _client.connect();
  return _client;
}
