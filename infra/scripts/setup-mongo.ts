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

  // signals — compound index for fast per-name lookups ordered by time. Keyed on the bare
  // (symbol, market) identity since Task 16a (the concatenated T212 ticker is no longer stored).
  await db.collection(COLLECTIONS.SIGNALS).createIndex(
    { symbol: 1, market: 1, generatedAt: -1 },
    { name: 'symbol_market_time' }
  );
  await db.collection(COLLECTIONS.SIGNALS).createIndex(
    { status: 1, generatedAt: -1 },
    { name: 'status_time' }
  );
  console.log(`Compound indexes on ${COLLECTIONS.SIGNALS}`);

  // instrument_registry — unique (symbol, market) constraint. Keyed on the bare identity since
  // Task 16b (the concatenated T212 ticker is no longer stored).
  await db.collection(COLLECTIONS.INSTRUMENT_REGISTRY).createIndex(
    { symbol: 1, market: 1 },
    { unique: true, name: 'unique_symbol_market' }
  );
  console.log(`Unique index on ${COLLECTIONS.INSTRUMENT_REGISTRY}.(symbol, market)`);

  // users — unique email constraint
  await db.collection(COLLECTIONS.USERS).createIndex(
    { email: 1 },
    { unique: true, name: 'unique_email' }
  );
  console.log(`Unique index on ${COLLECTIONS.USERS}.email`);

  // orders — compound index for portfolio queries. Keyed on the bare (symbol, market) identity
  // since Task 16a (the concatenated T212 ticker is no longer stored).
  await db.collection(COLLECTIONS.ORDERS).createIndex(
    { symbol: 1, market: 1, placedAt: -1 },
    { name: 'symbol_market_placed' }
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

  // risk_rejections — 90-day TTL audit log; indexed by timestamp for today-count queries
  if (!existingCollections.has(COLLECTIONS.RISK_REJECTIONS)) {
    await db.createCollection(COLLECTIONS.RISK_REJECTIONS);
  }
  await db.collection(COLLECTIONS.RISK_REJECTIONS).createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'ttl_90d' }
  );
  console.log(`TTL index on ${COLLECTIONS.RISK_REJECTIONS}.timestamp (90 days)`);

  // risk_state — singleton document; no special indexes needed
  if (!existingCollections.has(COLLECTIONS.RISK_STATE)) {
    await db.createCollection(COLLECTIONS.RISK_STATE);
  }
  console.log(`Created collection: ${COLLECTIONS.RISK_STATE}`);

  // model_versions — 90-day retrain cadence; indexed by strategy + promoted_at for shadow-test queries
  if (!existingCollections.has(COLLECTIONS.MODEL_VERSIONS)) {
    await db.createCollection(COLLECTIONS.MODEL_VERSIONS);
  }
  await db.collection(COLLECTIONS.MODEL_VERSIONS).createIndex(
    { strategy: 1, promoted_at: -1 },
    { name: 'strategy_promoted' }
  );
  await db.collection(COLLECTIONS.MODEL_VERSIONS).createIndex(
    { status: 1, strategy: 1 },
    { name: 'status_strategy' }
  );
  console.log(`Indexes on ${COLLECTIONS.MODEL_VERSIONS}`);

  await client.close();
  console.log('MongoDB setup complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
