import { Hono } from 'hono';
import { getRedisClient } from '@trader/shared-redis';
import { getMongoDb } from '@trader/shared-mongo';
import { createSignalDataLayer } from './infrastructure/data.ts';
import { MongoSignalRepository } from './infrastructure/repositories/MongoSignalRepository.ts';
import { RedisSignalPublisher } from './infrastructure/messaging/RedisSignalPublisher.ts';
import { RedisStrategySubscriber } from './infrastructure/messaging/RedisStrategySubscriber.ts';
import { MongoPortfolioState } from './infrastructure/MongoPortfolioState.ts';
import { GenerateSignalsUseCase } from './application/use-cases/GenerateSignals.ts';
import { ApproveSignalUseCase } from './application/use-cases/ApproveSignal.ts';
import { createRouter } from './infrastructure/http/router.ts';
import { createInternalRouter } from './infrastructure/http/internal-router.ts';

const app = new Hono();
app.get('/health', (c) => c.json({ status: 'ok' }));

async function main() {
  const redis = await getRedisClient();
  const db    = await getMongoDb();

  // Data layer: configure adapters, subscribe to invalidations
  const { manager, cache, bus } = createSignalDataLayer(db, redis);
  await bus.subscribe('signals', (key) => cache.invalidate(key));

  // Repository receives only interfaces — adapter choice is invisible to it
  const signalRepo = new MongoSignalRepository(manager, cache, bus);

  // Use cases receive only domain ports
  const portfolioState  = new MongoPortfolioState(db.collection('positions'));
  const generateSignals = new GenerateSignalsUseCase(signalRepo, new RedisSignalPublisher(redis), portfolioState);
  const approveSignal   = new ApproveSignalUseCase(signalRepo);
  const findRecent      = { execute: (limit: number) => signalRepo.findRecent(limit) };

  await new RedisStrategySubscriber(redis).subscribe(
    (features) => generateSignals.execute(features),
  );

  // Cross-service: clear market cache when market-data-service publishes new bars
  await bus.subscribe('market', async (_key) => {
    await cache.invalidatePattern('*');
  });

  app.route('/', createRouter({ findRecent, approveSignal }));
  app.route('/', createInternalRouter({ findRecent, approveSignal }));
}

main().catch((err) => {
  console.error('[fatal] startup failed:', err);
  process.exit(1);
});

export default { port: 3003, fetch: app.fetch };
