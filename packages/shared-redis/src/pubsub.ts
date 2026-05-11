import type { RedisClientType } from 'redis';

export async function publish(
  client: RedisClientType,
  channel: string,
  payload: unknown,
): Promise<void> {
  await client.publish(channel, JSON.stringify(payload));
}

export async function subscribe(
  client: RedisClientType,
  channel: string,
  handler: (payload: unknown) => void | Promise<void>,
): Promise<() => void> {
  const subscriber = client.duplicate() as unknown as RedisClientType;
  await subscriber.connect();
  await subscriber.subscribe(channel, (message) => {
    handler(JSON.parse(message));
  });
  return () => { subscriber.disconnect().catch(console.error); };
}
