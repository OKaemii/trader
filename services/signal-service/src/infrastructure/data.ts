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

const toMs = (v: unknown): number | undefined =>
  v instanceof Date ? v.getTime() : typeof v === 'number' ? v : undefined;

const toSignalDoc = (s: TradeSignal) => ({
  _id: s.id,
  ticker: s.ticker,
  strategy_id: s.strategy_id,
  action: s.action,
  confidence: s.confidence,
  targetWeight: s.targetWeight,
  rationale: s.rationale,
  timestamp: new Date(s.timestamp),
  approved: s.approved,
  entryPrice: s.entryPrice,
  lifecycle: s.lifecycle,
  approvedAt: s.approvedAt ? new Date(s.approvedAt) : undefined,
  executedAt: s.executedAt ? new Date(s.executedAt) : undefined,
  closedAt:   s.closedAt   ? new Date(s.closedAt)   : undefined,
  exitPrice:  s.exitPrice,
});

const fromSignalDoc = (doc: any): TradeSignal =>
  new TradeSignal({
    id: String(doc._id),
    timestamp: toMs(doc.timestamp) ?? Date.now(),
    ticker: doc.ticker,
    strategy_id: doc.strategy_id ?? 'unknown',
    action: doc.action,
    confidence: doc.confidence,
    targetWeight: doc.targetWeight,
    rationale: doc.rationale,
    approved: doc.approved ?? false,
    entryPrice: typeof doc.entryPrice === 'number' ? doc.entryPrice : undefined,
    lifecycle: doc.lifecycle,
    approvedAt: toMs(doc.approvedAt),
    executedAt: toMs(doc.executedAt),
    closedAt:   toMs(doc.closedAt),
    exitPrice: typeof doc.exitPrice === 'number' ? doc.exitPrice : undefined,
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
