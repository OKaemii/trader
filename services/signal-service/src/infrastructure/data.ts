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

const toSignalDoc = (s: TradeSignal): any => ({
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
  executedQuantity: s.executedQuantity,
  attempts: s.attempts,
  lastAttemptAt: s.lastAttemptAt ? new Date(s.lastAttemptAt) : undefined,
  failureReason: s.failureReason,
  failureDetail: s.failureDetail,
});

const fromSignalDoc = (doc: any): TradeSignal => {
  const params: any = {
    id: String(doc._id),
    timestamp: toMs(doc.timestamp) ?? Date.now(),
    ticker: doc.ticker,
    strategy_id: doc.strategy_id ?? 'unknown',
    action: doc.action,
    confidence: doc.confidence,
    targetWeight: doc.targetWeight,
    rationale: doc.rationale,
    approved: doc.approved ?? false,
    lifecycle: doc.lifecycle,
    attempts: typeof doc.attempts === 'number' ? doc.attempts : 0,
  };
  if (typeof doc.entryPrice === 'number')       params.entryPrice       = doc.entryPrice;
  if (typeof doc.exitPrice === 'number')        params.exitPrice        = doc.exitPrice;
  if (typeof doc.executedQuantity === 'number') params.executedQuantity = doc.executedQuantity;
  if (typeof doc.failureDetail === 'string')    params.failureDetail    = doc.failureDetail;
  if (doc.failureReason !== undefined)          params.failureReason    = doc.failureReason;
  const approvedAt = toMs(doc.approvedAt);   if (approvedAt   !== undefined) params.approvedAt    = approvedAt;
  const executedAt = toMs(doc.executedAt);   if (executedAt   !== undefined) params.executedAt    = executedAt;
  const closedAt   = toMs(doc.closedAt);     if (closedAt     !== undefined) params.closedAt      = closedAt;
  const lastAt     = toMs(doc.lastAttemptAt); if (lastAt      !== undefined) params.lastAttemptAt = lastAt;
  return new TradeSignal(params);
};

export { toSignalDoc, fromSignalDoc };

export const createSignalDataLayer = (
  db: Db,
  redis: RedisClientType,
): {
  manager: IDataManager<TradeSignal>;
  cache: ICache<TradeSignal>;
  bus: ICacheInvalidationBus;
  // Raw collection handle for atomic operations the IDataManager interface doesn't expose
  // (findOneAndUpdate, $inc with $set in one round trip). Used by MongoSignalRepository for
  // claimNextQueued — concurrency-safe across multiple dispatcher pods.
  collection: ReturnType<Db['collection']>;
} => ({
  manager: new MongoDataAdapter(db.collection(COLLECTIONS.SIGNALS), toSignalDoc, fromSignalDoc),
  cache:   new RedisCacheAdapter<TradeSignal>(redis, 'signals', 3600),
  bus:     new RedisCacheInvalidationBus(redis),
  collection: db.collection(COLLECTIONS.SIGNALS),
});
