import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock shared-mongo BEFORE importing live-config so the dynamic mongo lookup is captured.
let findOneImpl: () => Promise<any> = async () => null;

vi.mock('@trader/shared-mongo', () => ({
  COLLECTIONS: { PORTAL_MARKET_CONFIG: 'portal_market_config' },
  getMongoDb: async () => ({
    collection: () => ({ findOne: (q: any) => findOneImpl() }),
  }),
}));

const liveConfig = await import('../shared/live-config.ts');

describe('live-config', () => {
  beforeEach(() => {
    liveConfig.invalidateLiveConfig();
    // Reset to a known baseline. Each test calls configureLiveConfig() again with the
    // specific env defaults it wants to assert against.
    liveConfig.configureLiveConfig({ barFrequency: 'daily', pollIntervalMs: 24 * 60 * 60_000 });
  });
  afterEach(() => {
    findOneImpl = async () => null;
  });

  it('falls back to env defaults when override doc is missing', async () => {
    findOneImpl = async () => null;
    liveConfig.configureLiveConfig({ barFrequency: 'daily', pollIntervalMs: 24 * 60 * 60_000 });
    const cfg = await liveConfig.getLiveConfig();
    expect(cfg.barFrequency).toBe('daily');
    expect(cfg.pollIntervalMs).toBe(24 * 60 * 60_000);
  });

  it('uses intraday env default when set', async () => {
    findOneImpl = async () => null;
    liveConfig.configureLiveConfig({ barFrequency: 'intraday', pollIntervalMs: 15 * 60_000 });
    liveConfig.invalidateLiveConfig();
    const cfg = await liveConfig.getLiveConfig();
    expect(cfg.barFrequency).toBe('intraday');
    expect(cfg.pollIntervalMs).toBe(15 * 60_000);
  });

  it('applies override doc fields and falls back per-field', async () => {
    findOneImpl = async () => ({
      _id: 'singleton',
      barFrequency: 'intraday',
      pollIntervalMs: null,
      updatedBy: 'tester',
      updatedAt: new Date(),
    });
    liveConfig.configureLiveConfig({ barFrequency: 'daily', pollIntervalMs: 24 * 60 * 60_000 });
    liveConfig.invalidateLiveConfig();
    const cfg = await liveConfig.getLiveConfig();
    expect(cfg.barFrequency).toBe('intraday');     // from override
    expect(cfg.pollIntervalMs).toBe(24 * 60 * 60_000);  // from env default (override null)
  });

  it('caches reads for 15 s', async () => {
    let calls = 0;
    findOneImpl = async () => { calls++; return null; };
    liveConfig.invalidateLiveConfig();
    await liveConfig.getLiveConfig();
    await liveConfig.getLiveConfig();
    await liveConfig.getLiveConfig();
    expect(calls).toBe(1);
  });

  it('invalidateLiveConfig forces a re-read', async () => {
    let calls = 0;
    findOneImpl = async () => { calls++; return null; };
    liveConfig.invalidateLiveConfig();
    await liveConfig.getLiveConfig();
    liveConfig.invalidateLiveConfig();
    await liveConfig.getLiveConfig();
    expect(calls).toBe(2);
  });

  it('returns env defaults when mongo read throws', async () => {
    findOneImpl = async () => { throw new Error('mongo down'); };
    liveConfig.configureLiveConfig({ barFrequency: 'daily', pollIntervalMs: 24 * 60 * 60_000 });
    liveConfig.invalidateLiveConfig();
    const cfg = await liveConfig.getLiveConfig();
    expect(cfg.barFrequency).toBe('daily');
    expect(cfg.pollIntervalMs).toBe(24 * 60 * 60_000);
  });
});
