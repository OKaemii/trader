import { MongoDataAdapter } from '@trader/shared-data/adapters/MongoDataAdapter';
import { RedisCacheAdapter } from '@trader/shared-data/adapters/RedisCacheAdapter';
import { RedisCacheInvalidationBus } from '@trader/shared-data/adapters/RedisCacheInvalidationBus';
import type { IDataManager } from '@trader/shared-data/interfaces/IDataManager';
import type { ICache } from '@trader/shared-data/interfaces/ICache';
import type { ICacheInvalidationBus } from '@trader/shared-data/interfaces/ICacheInvalidationBus';
import { TradeSignal } from '../modules/signals/domain/TradeSignal.ts';
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
  queuedAt:   s.queuedAt   ? new Date(s.queuedAt)   : undefined,
  executedAt: s.executedAt ? new Date(s.executedAt) : undefined,
  closedAt:   s.closedAt   ? new Date(s.closedAt)   : undefined,
  exitPrice:  s.exitPrice,
  executedQuantity: s.executedQuantity,
  attempts: s.attempts,
  lastAttemptAt: s.lastAttemptAt ? new Date(s.lastAttemptAt) : undefined,
  failureReason: s.failureReason,
  failureDetail: s.failureDetail,
  // Per-signal slice of the cycle's StrategyOutput, attached by GenerateSignals for
  // downstream notification enrichment (sector, score, regime, multiplier). Compact
  // by construction (ticker_universe + covariance_matrix are stripped at emit time)
  // — typical doc ~300 bytes. Old signals without this field round-trip as undefined
  // and renderers fall back to defaults.
  features_snapshot: s.features_snapshot,
  pieId: s.pieId,
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
  const queuedAt   = toMs(doc.queuedAt);     if (queuedAt     !== undefined) params.queuedAt      = queuedAt;
  const executedAt = toMs(doc.executedAt);   if (executedAt   !== undefined) params.executedAt    = executedAt;
  const closedAt   = toMs(doc.closedAt);     if (closedAt     !== undefined) params.closedAt      = closedAt;
  const lastAt     = toMs(doc.lastAttemptAt); if (lastAt      !== undefined) params.lastAttemptAt = lastAt;
  if (doc.features_snapshot && typeof doc.features_snapshot === 'object') {
    params.features_snapshot = doc.features_snapshot;
  }
  if (typeof doc.pieId === 'string') params.pieId = doc.pieId;
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
