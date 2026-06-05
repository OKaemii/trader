// LiveConfig — reads runtime override doc (portal_market_config) from MongoDB,
// caches for 15s, falls back to env defaults. Override > Helm/env > built-in default.

import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import { log } from '../logger.ts';

export interface MarketConfigDoc {
    _id: 'singleton';
    barFrequency: 'daily' | 'intraday' | null;
    pollIntervalMs: number | null;
    universeMaxSize: number | null;
    updatedBy: string;
    updatedAt: Date;
}

export interface LiveConfig {
    barFrequency: 'daily' | 'intraday';
    pollIntervalMs: number;
    universeMaxSize: number;
}

// Module-level defaults set once at boot via configureLiveConfig(). Override docs in Mongo
// take precedence; this is the fallback when no override is set.
let _envDefaults: LiveConfig = { barFrequency: 'daily', pollIntervalMs: 24 * 60 * 60_000, universeMaxSize: 150 };

export function configureLiveConfig(envDefaults: LiveConfig): void {
    _envDefaults = envDefaults;
}

const CACHE_MS = 15_000;
let cached: { value: LiveConfig; ts: number } | null = null;

export async function getLiveConfig(): Promise<LiveConfig> {
    if (cached && Date.now() - cached.ts < CACHE_MS) return cached.value;
    let doc: MarketConfigDoc | null = null;
    try {
        const db = await getMongoDb();
        doc = await db.collection<MarketConfigDoc>(COLLECTIONS.PORTAL_MARKET_CONFIG)
            .findOne({ _id: 'singleton' });
    } catch (err) {
        log.warn('[live-config] mongo read failed, using env defaults:', err);
    }
    const value: LiveConfig = {
        barFrequency:    doc?.barFrequency    ?? _envDefaults.barFrequency,
        pollIntervalMs:  doc?.pollIntervalMs  ?? _envDefaults.pollIntervalMs,
        universeMaxSize: doc?.universeMaxSize ?? _envDefaults.universeMaxSize,
    };
    cached = { value, ts: Date.now() };
    return value;
}

export function invalidateLiveConfig(): void {
    cached = null;
}

export function _envDefaultsForTest(): LiveConfig {
    return _envDefaults;
}
