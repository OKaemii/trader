import { MongoClient, type Db } from 'mongodb';

let _client: MongoClient | null = null;

export async function getMongoClient(): Promise<MongoClient> {
  if (_client) return _client;
  _client = new MongoClient(process.env.MONGODB_URL ?? 'mongodb://mongodb:27017');
  await _client.connect();
  return _client;
}

export async function getMongoDb(dbName?: string): Promise<Db> {
  const client = await getMongoClient();
  return client.db(dbName ?? process.env.MONGODB_DB ?? 'trader');
}
