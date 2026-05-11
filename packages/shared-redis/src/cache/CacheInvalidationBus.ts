import type { RedisClientType } from 'redis';

export class CacheInvalidationBus {
  private subscriber: RedisClientType | null = null;

  constructor(private readonly redis: RedisClientType) {}

  async publish(namespace: string, key: string): Promise<void> {
    await this.redis.publish(`cache:invalidated:${namespace}`, key);
  }

  async subscribe(namespace: string, handler: (key: string) => Promise<void>): Promise<void> {
    this.subscriber = this.redis.duplicate() as unknown as RedisClientType;
    await this.subscriber.connect();
    await this.subscriber.subscribe(`cache:invalidated:${namespace}`, (key) => {
      handler(key).catch(console.error);
    });
  }

  async unsubscribe(): Promise<void> {
    await this.subscriber?.disconnect();
  }
}
