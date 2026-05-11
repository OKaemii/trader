import { MongoDataAdapter } from '@trader/shared-data/adapters/MongoDataAdapter';
import { RedisCacheAdapter } from '@trader/shared-data/adapters/RedisCacheAdapter';
import { RedisCacheInvalidationBus } from '@trader/shared-data/adapters/RedisCacheInvalidationBus';
import type { IDataManager } from '@trader/shared-data/interfaces/IDataManager';
import type { ICache } from '@trader/shared-data/interfaces/ICache';
import type { ICacheInvalidationBus } from '@trader/shared-data/interfaces/ICacheInvalidationBus';
import { TradeSignal } from '../domain/entities/TradeSignal.ts';
import { COLLECTIONS } from '@trader/shared-mongo';
import type { Db } from 'mongodb';
import type { RedisClientType } from 'redis';

const toSignalDoc = (s: TradeSignal) => ({
  _id: s.id,
  ticker: s.ticker,
  action: s.action,
  confidence: s.confidence,
  targetWeight: s.targetWeight,
  rationale: s.rationale,
  timestamp: new Date(s.timestamp),
  approved: s.approved,
});

const fromSignalDoc = (doc: any): TradeSignal =>
  new TradeSignal({
    id: String(doc._id),
    timestamp: doc.timestamp instanceof Date ? doc.timestamp.getTime() : doc.timestamp,
    ticker: doc.ticker,
    action: doc.action,
    confidence: doc.confidence,
    targetWeight: doc.targetWeight,
    rationale: doc.rationale,
    approved: doc.approved ?? false,
  });

export const createSignalDataLayer = (
  db: Db,
  redis: RedisClientType,
): {
  manager: IDataManager<TradeSignal>;
  cache: ICache<TradeSignal>;
  bus: ICacheInvalidationBus;
} => ({
  manager: new MongoDataAdapter(db.collection(COLLECTIONS.SIGNALS), toSignalDoc, fromSignalDoc),
  cache:   new RedisCacheAdapter<TradeSignal>(redis, 'signals', 3600),
  bus:     new RedisCacheInvalidationBus(redis),
});
