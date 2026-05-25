import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLogger } from "@trader/core";

// Mock shared-mongo BEFORE importing the module under test so the dynamic mongo
// lookup inside live-config is captured.
let findOneImpl: () => Promise<any> = async () => null;

vi.mock('@trader/shared-mongo', () => ({
  COLLECTIONS: { PORTAL_MARKET_CONFIG: 'portal_market_config' },
  getMongoDb: async () => ({
    collection: () => ({ findOne: () => findOneImpl() }),
  }),
}));

const liveConfig = await import('../modules/orders/infrastructure/live-config.ts');
const { OrderType } = await import('../modules/orders/domain/Order.ts');
const testLogger = createLogger({ service: "trading-service-test", enabledLevels: ["error"] });

function setEnvDefault(raw: string | undefined): void {
  liveConfig.configureLiveConfig({ logger: testLogger, envDefault: liveConfig.parseSignalOrderType(raw) });
}

describe('trading-service live-config', () => {
  beforeEach(() => {
    liveConfig.invalidateSignalOrderType();
    setEnvDefault(undefined);   // baseline = Limit
  });
  afterEach(() => {
    findOneImpl = async () => null;
  });

  it('falls back to env default (Limit) when override is missing', async () => {
    findOneImpl = async () => null;
    const mode = await liveConfig.getSignalOrderType();
    expect(mode).toBe(OrderType.Limit);
  });

  it('honours env override when no doc is present', async () => {
    findOneImpl = async () => null;
    setEnvDefault('Market');
    liveConfig.invalidateSignalOrderType();
    const mode = await liveConfig.getSignalOrderType();
    expect(mode).toBe(OrderType.Market);
  });

  it('is case-insensitive on the env (defends against legacy lowercase Helm/Terraform values)', async () => {
    findOneImpl = async () => null;
    setEnvDefault('market');   // legacy lowercase
    liveConfig.invalidateSignalOrderType();
    const mode = await liveConfig.getSignalOrderType();
    expect(mode).toBe(OrderType.Market);
  });

  it('accepts the integer form of the env (in case ops parameterises by value)', async () => {
    findOneImpl = async () => null;
    setEnvDefault(String(OrderType.Market));
    liveConfig.invalidateSignalOrderType();
    const mode = await liveConfig.getSignalOrderType();
    expect(mode).toBe(OrderType.Market);
  });

  it('prefers the Mongo override over env', async () => {
    findOneImpl = async () => ({ _id: 'singleton', signalOrderType: OrderType.Market });
    setEnvDefault('Limit');
    liveConfig.invalidateSignalOrderType();
    const mode = await liveConfig.getSignalOrderType();
    expect(mode).toBe(OrderType.Market);
  });

  it('null override falls back to env default', async () => {
    findOneImpl = async () => ({ _id: 'singleton', signalOrderType: null });
    const mode = await liveConfig.getSignalOrderType();
    expect(mode).toBe(OrderType.Limit);
  });

  it('ignores out-of-enum stored values and uses env default', async () => {
    // An old string-form doc ('t212') from before the enum rename should not be honoured.
    findOneImpl = async () => ({ _id: 'singleton', signalOrderType: 't212' });
    const mode = await liveConfig.getSignalOrderType();
    expect(mode).toBe(OrderType.Limit);
  });

  it('caches reads inside the 15s window', async () => {
    let calls = 0;
    findOneImpl = async () => { calls++; return null; };
    liveConfig.invalidateSignalOrderType();
    await liveConfig.getSignalOrderType();
    await liveConfig.getSignalOrderType();
    await liveConfig.getSignalOrderType();
    expect(calls).toBe(1);
  });

  it('invalidateSignalOrderType forces a re-read on the next call', async () => {
    let calls = 0;
    findOneImpl = async () => { calls++; return null; };
    liveConfig.invalidateSignalOrderType();
    await liveConfig.getSignalOrderType();
    liveConfig.invalidateSignalOrderType();
    await liveConfig.getSignalOrderType();
    expect(calls).toBe(2);
  });

  it('returns env default when mongo read throws', async () => {
    findOneImpl = async () => { throw new Error('mongo down'); };
    setEnvDefault('Market');
    liveConfig.invalidateSignalOrderType();
    const mode = await liveConfig.getSignalOrderType();
    expect(mode).toBe(OrderType.Market);
  });
});
