// LiveConfig — reads the runtime SIGNAL_ORDER_TYPE override from MongoDB
// (portal_market_config.signalOrderType), caches for 15s, falls back to env. Subscribed
// to the `config:invalidated` pubsub topic so a portal save drops the cache instantly
// instead of waiting on the TTL. This is what lets the operator flip Limit ⇄ Market
// from the portal without restarting trading-service.

import type { Logger } from '@trader/core';
import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import { OrderType } from '../domain/entities/Order.ts';

let _logger: Logger | null = null;
export function setLiveConfigLogger(logger: Logger): void { _logger = logger; }

interface MarketConfigDoc {
  _id: 'singleton';
  // Stored as the numeric enum value (0 = Limit, 1 = Market). `null` means "no override,
  // use env default". Persisting the integer keeps the schema stable across enum-member
  // renames — only the position of a value would break it, and the enum is closed.
  signalOrderType: OrderType | null;
}

const CACHE_MS = 15_000;
let cached: { value: OrderType; ts: number } | null = null;

const envSignalOrderType = (): OrderType => {
  // Helm sets SIGNAL_ORDER_TYPE to the member name (Limit / Market) for human readability;
  // we accept the raw integer too, and we lowercase before comparing so the legacy
  // value 'market' from old Helm/Terraform state doesn't silently fall through to Limit.
  const raw = (process.env.SIGNAL_ORDER_TYPE ?? '').toLowerCase();
  if (raw === 'market' || raw === String(OrderType.Market)) return OrderType.Market;
  return OrderType.Limit;
};

export async function getSignalOrderType(): Promise<OrderType> {
  if (cached && Date.now() - cached.ts < CACHE_MS) return cached.value;
  let doc: Pick<MarketConfigDoc, 'signalOrderType'> | null = null;
  try {
    const db = await getMongoDb();
    doc = await db.collection<MarketConfigDoc>(COLLECTIONS.PORTAL_MARKET_CONFIG)
      .findOne({ _id: 'singleton' }, { projection: { signalOrderType: 1 } });
  } catch (err) {
    if (_logger) _logger.warn({ err }, 'live-config: mongo read failed, using env default');
  }
  const stored = doc?.signalOrderType;
  const value: OrderType =
    stored === OrderType.Limit || stored === OrderType.Market
      ? stored
      : envSignalOrderType();
  cached = { value, ts: Date.now() };
  return value;
}

export function invalidateSignalOrderType(): void {
  cached = null;
}

// Exported for unit tests so they can assert env-default behaviour without touching
// the cache directly.
export function _envDefaultForTest(): OrderType {
  return envSignalOrderType();
}
