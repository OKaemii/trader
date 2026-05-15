import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// Mock shared-mongo BEFORE importing live-config so the dynamic mongo lookup is captured.
let findOneImpl: () => Promise<any> = async () => null;

mock.module('@trader/shared-mongo', () => ({
  COLLECTIONS: { PORTAL_MARKET_CONFIG: 'portal_market_config' },
  getMongoDb: async () => ({
    collection: () => ({ findOne: (q: any) => findOneImpl() }),
  }),
}));

const liveConfig = await import('../live-config.ts');

describe('live-config', () => {
  beforeEach(() => {
    liveConfig.invalidateLiveConfig();
    delete process.env.BAR_FREQUENCY;
    delete process.env.POLL_INTERVAL_MS;
  });
  afterEach(() => {
    findOneImpl = async () => null;
  });

  it('falls back to env defaults when override doc is missing', async () => {
    findOneImpl = async () => null;
    process.env.BAR_FREQUENCY = 'daily';
    const cfg = await liveConfig.getLiveConfig();
    expect(cfg.barFrequency).toBe('daily');
    expect(cfg.pollIntervalMs).toBe(24 * 60 * 60_000);
  });

  it('uses intraday env default when set', async () => {
    findOneImpl = async () => null;
    process.env.BAR_FREQUENCY = 'intraday';
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
    process.env.BAR_FREQUENCY = 'daily';
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
    process.env.BAR_FREQUENCY = 'daily';
    liveConfig.invalidateLiveConfig();
    const cfg = await liveConfig.getLiveConfig();
    expect(cfg.barFrequency).toBe('daily');
    expect(cfg.pollIntervalMs).toBe(24 * 60 * 60_000);
  });
});
