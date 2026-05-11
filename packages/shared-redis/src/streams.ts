import type { RedisClientType } from 'redis';

export async function xAdd(
  client: RedisClientType,
  stream: string,
  payload: unknown,
): Promise<string> {
  return client.xAdd(stream, '*', { data: JSON.stringify(payload) });
}

export async function ensureConsumerGroup(
  client: RedisClientType,
  stream: string,
  group: string,
): Promise<void> {
  try {
    await client.xGroupCreate(stream, group, '$', { MKSTREAM: true });
  } catch (e: unknown) {
    if (!String(e).includes('BUSYGROUP')) throw e;
    // Group already exists — safe to ignore
  }
}

export interface StreamEntry {
  id: string;
  data: unknown;
}

export async function xReadGroup(
  client: RedisClientType,
  group: string,
  consumer: string,
  stream: string,
  count = 10,
  blockMs = 5000,
): Promise<StreamEntry[]> {
  const messages = await client.xReadGroup(
    group,
    consumer,
    [{ key: stream, id: '>' }],
    { COUNT: count, BLOCK: blockMs },
  );
  if (!messages) return [];
  const entries: StreamEntry[] = [];
  for (const { messages: msgs } of messages) {
    for (const { id, message } of msgs) {
      entries.push({ id, data: JSON.parse(message.data as string) });
    }
  }
  return entries;
}

export async function xAck(
  client: RedisClientType,
  stream: string,
  group: string,
  id: string,
): Promise<void> {
  await client.xAck(stream, group, id);
}
