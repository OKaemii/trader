import type { Collection, Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import { COLLECTIONS } from '@trader/shared-mongo';

export type StrategyHealth = 'healthy' | 'warning' | 'degraded' | 'suspended';

export interface LiveStrategyMetrics {
  rollingSharpe30d: number;   // rolling 30-day Sharpe of paper signals; >= 0 = pass
  hitRate30d: number;         // fraction of BUY signals with positive forward outcome; >= 0.47 = pass
  turnoverRatio: number;      // weekly portfolio turnover / weekly budget; <= 2.0 = pass
  icTStat: number;            // IC t-statistic from signal vs forward-return rank correlation; >= 1.0 = pass
  featureDriftKL: number;     // KL divergence of live feature dist vs training baseline; <= 0.6 = pass
  computedAt: number;
}

interface HealthLogEntry {
  health: StrategyHealth;
  metrics: LiveStrategyMetrics;
  passedChecks: number;
  timestamp: Date;
}

export class StrategyDecayMonitor {
  private readonly healthLog: Collection<HealthLogEntry>;
  private readonly redis: RedisClientType;
  private readonly signals: Collection;

  constructor(db: Db, redis: RedisClientType) {
    this.healthLog = db.collection(COLLECTIONS.STRATEGY_HEALTH_LOG);
    this.signals   = db.collection(COLLECTIONS.SIGNALS);
    this.redis     = redis;
  }

  checkHealth(metrics: LiveStrategyMetrics): StrategyHealth {
    const checks = [
      metrics.rollingSharpe30d >= 0,
      metrics.hitRate30d       >= 0.47,
      metrics.turnoverRatio    <= 2.0,
      metrics.icTStat          >= 1.0,
      metrics.featureDriftKL   <= 0.6,
    ];
    const passed = checks.filter(Boolean).length;
    if (passed === 5) return 'healthy';
    if (passed >= 4) return 'warning';
    if (passed >= 2) return 'degraded';
    return 'suspended';
  }

  async getLastMetrics(): Promise<LiveStrategyMetrics | null> {
    const last = await this.healthLog.find({}).sort({ timestamp: -1 }).limit(1).toArray();
    return last[0]?.metrics ?? null;
  }

  async run(overrideMetrics?: Partial<LiveStrategyMetrics>): Promise<StrategyHealth> {
    const computed = await this._computeMetrics();
    const metrics: LiveStrategyMetrics = { ...computed, ...overrideMetrics };
    const health = this.checkHealth(metrics);
    await this._persist(health, metrics);
    return health;
  }

  private async _computeMetrics(): Promise<LiveStrategyMetrics> {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    // Health metrics must reflect what actually traded, not noise/queued/failed. Filtering
    // to lifecycle ∈ {executed, closed} ensures the turnover ratio (and any future metric
    // computed from this query) treats failed signals as if they never happened.
    const recentSignals = await this.signals
      .find({
        timestamp: { $gte: new Date(thirtyDaysAgo) },
        lifecycle: { $in: ['executed', 'closed'] },
      })
      .sort({ timestamp: -1 })
      .limit(500)
      .toArray();

    // turnoverRatio: average |targetWeight change| across recent signals, normalised to weekly budget (0.5 weekly)
    let turnoverRatio = 1.0;
    if (recentSignals.length >= 2) {
      const weightChanges = recentSignals
        .filter((s) => typeof (s as any).targetWeight === 'number')
        .map((s) => Math.abs((s as any).targetWeight ?? 0));
      const avgChange = weightChanges.length
        ? weightChanges.reduce((a, b) => a + b, 0) / weightChanges.length
        : 0;
      // Normalise: weekly budget = 0.5 (50% of portfolio turnover per week)
      const weeklyBudget = 0.5;
      const signalsPerWeek = (recentSignals.length / 30) * 7;
      const estimatedWeeklyTurnover = avgChange * signalsPerWeek;
      turnoverRatio = weeklyBudget > 0 ? estimatedWeeklyTurnover / weeklyBudget : 1.0;
    }

    // Other metrics require forward-return data not available in paper mode.
    // Defaults represent neutral/healthy values during the bootstrap period.
    // Backtest engine (Step 18) populates these on every backtest run.
    const lastLog = await this.healthLog
      .find({})
      .sort({ timestamp: -1 })
      .limit(1)
      .toArray();

    const prev = lastLog[0]?.metrics;

    return {
      rollingSharpe30d: prev?.rollingSharpe30d ?? 0.5,
      hitRate30d:       prev?.hitRate30d       ?? 0.52,
      turnoverRatio:    Math.max(0, turnoverRatio),
      icTStat:          prev?.icTStat          ?? 1.5,
      featureDriftKL:   prev?.featureDriftKL   ?? 0.1,
      computedAt:       Date.now(),
    };
  }

  private async _persist(health: StrategyHealth, metrics: LiveStrategyMetrics): Promise<void> {
    await this.redis.set('strategy:health', health);

    const checks = [
      metrics.rollingSharpe30d >= 0,
      metrics.hitRate30d       >= 0.47,
      metrics.turnoverRatio    <= 2.0,
      metrics.icTStat          >= 1.0,
      metrics.featureDriftKL   <= 0.6,
    ];

    await this.healthLog.insertOne({
      health,
      metrics,
      passedChecks: checks.filter(Boolean).length,
      timestamp: new Date(),
    });

    if (health === 'degraded' || health === 'suspended') {
      console.warn(`[StrategyDecayMonitor] strategy ${health} — metrics:`, metrics);
    }
  }
}
