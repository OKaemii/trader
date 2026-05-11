/**
 * One-time MongoDB setup: Time Series collections, TTL indexes, compound indexes.
 * Run once against a fresh cluster: bun infra/scripts/setup-mongo.ts
 */

import { MongoClient } from 'mongodb';
import { COLLECTIONS } from '../../packages/shared-mongo/src/collections';

const MONGO_URI = process.env.MONGO_URI ?? 'mongodb://localhost:27017';
const DB_NAME   = process.env.MONGO_DB   ?? 'trader';

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  const existingCollections = new Set(
    (await db.listCollections().toArray()).map(c => c.name)
  );

  // ohlcv_bars — Time Series collection (immutable; each bar is one document)
  if (!existingCollections.has(COLLECTIONS.OHLCV_BARS)) {
    await db.createCollection(COLLECTIONS.OHLCV_BARS, {
      timeseries: {
        timeField:   'timestamp',
        metaField:   'ticker',
        granularity: 'minutes',
      },
    });
    console.log(`Created time-series collection: ${COLLECTIONS.OHLCV_BARS}`);
  }

  // topology_snapshots — 90-day TTL; snapshots are ephemeral diagnostic data
  if (!existingCollections.has(COLLECTIONS.TOPOLOGY_SNAPSHOTS)) {
    await db.createCollection(COLLECTIONS.TOPOLOGY_SNAPSHOTS);
  }
  await db.collection(COLLECTIONS.TOPOLOGY_SNAPSHOTS).createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'ttl_90d' }
  );
  console.log(`TTL index on ${COLLECTIONS.TOPOLOGY_SNAPSHOTS}.createdAt (90 days)`);

  // strategy_health_log — 30-day TTL
  if (!existingCollections.has(COLLECTIONS.STRATEGY_HEALTH_LOG)) {
    await db.createCollection(COLLECTIONS.STRATEGY_HEALTH_LOG);
  }
  await db.collection(COLLECTIONS.STRATEGY_HEALTH_LOG).createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 30 * 24 * 60 * 60, name: 'ttl_30d' }
  );
  console.log(`TTL index on ${COLLECTIONS.STRATEGY_HEALTH_LOG}.createdAt (30 days)`);

  // signals — compound index for fast per-ticker lookups ordered by time
  await db.collection(COLLECTIONS.SIGNALS).createIndex(
    { ticker: 1, generatedAt: -1 },
    { name: 'ticker_time' }
  );
  await db.collection(COLLECTIONS.SIGNALS).createIndex(
    { status: 1, generatedAt: -1 },
    { name: 'status_time' }
  );
  console.log(`Compound indexes on ${COLLECTIONS.SIGNALS}`);

  // instrument_registry — unique ticker constraint
  await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY).createIndex(
    { ticker: 1 },
    { unique: true, name: 'unique_ticker' }
  );
  console.log(`Unique index on ${COLLECTIONS.INSTRUMENT_REGISTRY}.ticker`);

  // users — unique email constraint
  await db.collection(COLLECTIONS.USERS).createIndex(
    { email: 1 },
    { unique: true, name: 'unique_email' }
  );
  console.log(`Unique index on ${COLLECTIONS.USERS}.email`);

  // orders — compound index for portfolio queries
  await db.collection(COLLECTIONS.ORDERS).createIndex(
    { ticker: 1, placedAt: -1 },
    { name: 'ticker_placed' }
  );
  console.log(`Compound index on ${COLLECTIONS.ORDERS}`);

  // bad_ticks — 7-day TTL (diagnostic only)
  if (!existingCollections.has(COLLECTIONS.BAD_TICKS)) {
    await db.createCollection(COLLECTIONS.BAD_TICKS);
  }
  await db.collection(COLLECTIONS.BAD_TICKS).createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: 7 * 24 * 60 * 60, name: 'ttl_7d' }
  );
  console.log(`TTL index on ${COLLECTIONS.BAD_TICKS}.timestamp (7 days)`);

  await client.close();
  console.log('MongoDB setup complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
