// LiveConfig — reads runtime override doc (portal_market_config) from MongoDB,
// caches for 15s, falls back to env defaults. Override > Helm/env > built-in default.

import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';

export interface MarketConfigDoc {
  _id: 'singleton';
  barFrequency: 'daily' | 'intraday' | null;
  pollIntervalMs: number | null;
  updatedBy: string;
  updatedAt: Date;
}

export interface LiveConfig {
  barFrequency: 'daily' | 'intraday';
  pollIntervalMs: number;
}

const CACHE_MS = 15_000;
let cached: { value: LiveConfig; ts: number } | null = null;

const envBarFrequency = (): 'daily' | 'intraday' =>
  (process.env.BAR_FREQUENCY === 'intraday' ? 'intraday' : 'daily');

const envPollMs = (): number => {
  const def = envBarFrequency() === 'daily' ? 20 * 60_000 : 60_000;
  return parseInt(process.env.POLL_INTERVAL_MS ?? String(def));
};

export async function getLiveConfig(): Promise<LiveConfig> {
  if (cached && Date.now() - cached.ts < CACHE_MS) return cached.value;
  let doc: MarketConfigDoc | null = null;
  try {
    const db = await getMongoDb();
    doc = await db.collection<MarketConfigDoc>(COLLECTIONS.PORTAL_MARKET_CONFIG)
      .findOne({ _id: 'singleton' });
  } catch (err) {
    console.warn('[live-config] mongo read failed, using env defaults:', err);
  }
  const value: LiveConfig = {
    barFrequency: doc?.barFrequency ?? envBarFrequency(),
    pollIntervalMs: doc?.pollIntervalMs ?? envPollMs(),
  };
  cached = { value, ts: Date.now() };
  return value;
}

export function invalidateLiveConfig(): void {
  cached = null;
}

export function _envDefaultsForTest(): LiveConfig {
  return { barFrequency: envBarFrequency(), pollIntervalMs: envPollMs() };
}
