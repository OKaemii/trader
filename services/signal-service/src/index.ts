import { Hono } from 'hono';
import { getRedisClient } from '@trader/shared-redis';
import { getMongoDb } from '@trader/shared-mongo';
import { createSignalDataLayer } from './infrastructure/data.ts';
import { MongoSignalRepository } from './infrastructure/repositories/MongoSignalRepository.ts';
import { RedisSignalPublisher } from './infrastructure/messaging/RedisSignalPublisher.ts';
import { RedisStrategySubscriber } from './infrastructure/messaging/RedisStrategySubscriber.ts';
import { MongoPortfolioState } from './infrastructure/MongoPortfolioState.ts';
import { MongoPriceLookup } from './infrastructure/MongoPriceLookup.ts';
import { GenerateSignalsUseCase } from './application/use-cases/GenerateSignals.ts';
import { ApproveSignalUseCase } from './application/use-cases/ApproveSignal.ts';
import { GetSignalProgressUseCase } from './application/use-cases/GetSignalProgress.ts';
import { RiskEngine } from './application/services/RiskEngine.ts';
import { StrategyDecayMonitor } from './application/services/StrategyDecayMonitor.ts';
import { AutoApprovalGate } from './application/services/AutoApprovalGate.ts';
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

  // Risk engine: circuit breaker + audit log
  const riskEngine = new RiskEngine(db, redis);
  await riskEngine.init();

  // Strategy decay monitor: runs after every rebalance, writes to strategy:health + strategy_health_log
  const decayMonitor = new StrategyDecayMonitor(db, redis);

  // Use cases receive only domain ports
  const portfolioState  = new MongoPortfolioState(db.collection('positions'));
  const priceLookup     = new MongoPriceLookup(db);
  const approveSignal   = new ApproveSignalUseCase(signalRepo);
  const autoApprovalGate = new AutoApprovalGate(redis, signalRepo, approveSignal);
  const generateSignals = new GenerateSignalsUseCase(signalRepo, new RedisSignalPublisher(redis), portfolioState, riskEngine, undefined, decayMonitor, priceLookup, autoApprovalGate);
  const findRecent      = { execute: (limit: number) => signalRepo.findRecent(limit) };
  const getProgress     = new GetSignalProgressUseCase(signalRepo, portfolioState, priceLookup);

  await new RedisStrategySubscriber(redis).subscribe(
    (features) => generateSignals.execute(features),
  );

  // Cross-service: clear market cache when market-data-service publishes new bars
  await bus.subscribe('market', async (_key) => {
    await cache.invalidatePattern('*');
  });

  app.route('/', createRouter({ findRecent, approveSignal, getProgress, autoApprovalGate }));
  app.route('/', createInternalRouter({ findRecent, approveSignal, riskEngine, signalRepo }));

  // Prometheus metrics endpoint — scraped by kube-prometheus-stack for Grafana Strategy Health panel
  app.get('/metrics', async (c) => {
    try {
      const health = (await redis.get('strategy:health')) ?? 'unknown';
      const score  = ({ healthy: 1, warning: 0.75, degraded: 0.25, suspended: 0 } as Record<string, number>)[health] ?? -1;
      const m = await decayMonitor.getLastMetrics();
      const lines = [
        '# HELP strategy_health_score Health state (1=healthy 0.75=warning 0.25=degraded 0=suspended)',
        '# TYPE strategy_health_score gauge',
        `strategy_health_score ${score}`,
        '# HELP strategy_rolling_sharpe_30d Rolling 30-day Sharpe ratio',
        '# TYPE strategy_rolling_sharpe_30d gauge',
        `strategy_rolling_sharpe_30d ${m?.rollingSharpe30d ?? 0}`,
        '# HELP strategy_hit_rate_30d 30-day signal hit rate',
        '# TYPE strategy_hit_rate_30d gauge',
        `strategy_hit_rate_30d ${m?.hitRate30d ?? 0}`,
        '# HELP strategy_turnover_ratio Turnover ratio vs weekly budget',
        '# TYPE strategy_turnover_ratio gauge',
        `strategy_turnover_ratio ${m?.turnoverRatio ?? 0}`,
        '# HELP strategy_ic_tstat IC t-statistic',
        '# TYPE strategy_ic_tstat gauge',
        `strategy_ic_tstat ${m?.icTStat ?? 0}`,
        '# HELP strategy_feature_drift_kl Feature KL divergence from training baseline',
        '# TYPE strategy_feature_drift_kl gauge',
        `strategy_feature_drift_kl ${m?.featureDriftKL ?? 0}`,
      ];
      return new Response(lines.join('\n') + '\n', {
        headers: { 'Content-Type': 'text/plain; version=0.0.4' },
      });
    } catch {
      return new Response('# metrics unavailable\n', { headers: { 'Content-Type': 'text/plain' } });
    }
  });
}

main().catch((err) => {
  console.error('[fatal] startup failed:', err);
  process.exit(1);
});

// idleTimeout raised from Bun's 10s default. Even though ApproveSignal is now fire-and-forget,
// other handlers (notably the trading-service callback chain) can stall on slow downstream
// systems; a higher ceiling avoids spurious 502s under rate-limit-induced lag.
export default { port: 3003, idleTimeout: 60, fetch: app.fetch };
