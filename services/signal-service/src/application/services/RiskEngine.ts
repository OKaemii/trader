import type { Collection, Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import { CircuitBreakerRedis } from '../../infrastructure/CircuitBreakerRedis.ts';
import { RISK_LIMITS } from './LongOnlyOptimiser.ts';

export interface RiskStatus {
  circuit_open: boolean;
  circuit_reason: string | null;
  nav: number;
  hwm: number;
  daily_loss_pct: number;
  drawdown_from_hwm_pct: number;
  rejections_today: number;
  confidence_decay_factor: number;  // 1.0 = fresh model, 0.0 = stale (>120 days)
  limits: typeof RISK_LIMITS;
  checked_at: number;
}

interface RiskState {
  _id: string;
  hwm: number;
  day_open_nav: number;
  day_date: string;    // yyyy-mm-dd
  last_retrain_ts: number;  // Unix ms of last model retrain
  updated_at: Date;
}

// Explicit class for turnover budget — Section 16 checklist requirement.
export class TurnoverBudget {
  readonly weeklyLimit: number;

  constructor(weeklyLimit = RISK_LIMITS.maxWeeklyTurnover) {
    this.weeklyLimit = weeklyLimit;
  }

  computeBlendFactor(proposedTurnover: number): number {
    if (proposedTurnover <= this.weeklyLimit) return 1.0;
    return this.weeklyLimit / proposedTurnover;
  }
}

// OrderRouter — v1 paper mode: annotates signals with preferred execution type.
// Phase 3: routes to T212 API with limit-first, market fallback for risk exits.
export const OrderRouter = {
  signalOrderType: (): 'limit' => 'limit',          // prefer limit orders for signals
  riskExitOrderType: (): 'market' => 'market',       // market orders for risk-driven exits
} as const;

export class RiskEngine {
  private readonly rejections: Collection;
  private readonly riskState: Collection<RiskState>;
  private readonly positions: Collection;
  private readonly cb: CircuitBreakerRedis;

  private _state: RiskState = {
    _id: 'singleton',
    hwm: 0,
    day_open_nav: 0,
    day_date: '',
    last_retrain_ts: 0,
    updated_at: new Date(),
  };

  private _rejectionsToday = 0;

  constructor(db: Db, redis: RedisClientType) {
    this.rejections = db.collection('risk_rejections');
    this.riskState  = db.collection<RiskState>('risk_state');
    this.positions  = db.collection('positions');
    this.cb         = new CircuitBreakerRedis(redis);
  }

  async init(): Promise<void> {
    const saved = await this.riskState.findOne({ _id: 'singleton' });
    if (saved) this._state = saved;

    const today = this._today();
    if (this._state.day_date !== today) {
      const nav = await this._computeNav();
      this._state.day_open_nav = nav;
      this._state.day_date = today;
      await this._persistState();
    }

    this._rejectionsToday = await this.rejections.countDocuments({
      timestamp: { $gte: this._dayStartMs() },
    });
  }

  /**
   * Apply regime-based position size scaling.
   * Called by GenerateSignals after weights are computed.
   * positionSizeMultiplier: [0.25, 1.0] from RegimeState.
   */
  applyRegimeScaling(weights: number[], positionSizeMultiplier: number): number[] {
    const scale = Math.max(0.25, Math.min(1.0, positionSizeMultiplier));
    return weights.map((w) => w * scale);
  }

  /**
   * Confidence decay: returns a multiplier in [0,1].
   * 1.0 if model retrained within confidenceStaleDays.
   * Decays linearly to 0 between confidenceStaleDays and 120 days.
   */
  confidenceDecayFactor(): number {
    if (this._state.last_retrain_ts === 0) return 1.0; // never retrained — assume fresh at startup
    const daysSince = (Date.now() - this._state.last_retrain_ts) / (24 * 60 * 60 * 1000);
    const stale = RISK_LIMITS.confidenceStaleDays;
    const hard  = 120;
    if (daysSince <= stale) return 1.0;
    if (daysSince >= hard)  return 0.0;
    return 1.0 - (daysSince - stale) / (hard - stale);
  }

  /** Record a model retrain event — resets the confidence decay clock. */
  async recordRetrain(): Promise<void> {
    this._state.last_retrain_ts = Date.now();
    await this._persistState();
  }

  async canTrade(): Promise<{ allowed: boolean; reason: string | null }> {
    // Redis-backed circuit breaker check first
    const { open, reason: cbReason } = await this.cb.isOpen();
    if (open) return { allowed: false, reason: cbReason ?? 'Circuit breaker tripped' };

    const nav = await this._computeNav();

    if (this._state.hwm === 0) {
      this._state.hwm = nav;
      this._state.day_open_nav = nav;
      await this._persistState();
    }

    if (nav > this._state.hwm) {
      this._state.hwm = nav;
      await this._persistState();
    }

    const dailyLossPct = this._state.day_open_nav > 0
      ? (this._state.day_open_nav - nav) / this._state.day_open_nav
      : 0;

    const drawdownPct = this._state.hwm > 0
      ? (this._state.hwm - nav) / this._state.hwm
      : 0;

    if (dailyLossPct > RISK_LIMITS.maxDailyLoss) {
      const reason = `Daily loss ${(dailyLossPct * 100).toFixed(2)}% exceeds ${(RISK_LIMITS.maxDailyLoss * 100).toFixed(0)}% limit`;
      await this.cb.trip(reason);
      await this._logRejection('DAILY_LOSS_HALT', { dailyLossPct, nav });
      return { allowed: false, reason };
    }

    if (drawdownPct > RISK_LIMITS.maxDrawdownHalt) {
      const reason = `Drawdown ${(drawdownPct * 100).toFixed(2)}% exceeds ${(RISK_LIMITS.maxDrawdownHalt * 100).toFixed(0)}% HWM limit`;
      await this.cb.trip(reason);
      await this._logRejection('DRAWDOWN_HALT', { drawdownPct, hwm: this._state.hwm, nav });
      return { allowed: false, reason };
    }

    return { allowed: true, reason: null };
  }

  async resetCircuitBreaker(): Promise<void> {
    await this.cb.reset();
  }

  async logRejection(reason: string, detail: Record<string, unknown>): Promise<void> {
    await this._logRejection(reason, detail);
  }

  async status(): Promise<RiskStatus> {
    const nav = await this._computeNav();
    const dailyLossPct = this._state.day_open_nav > 0
      ? (this._state.day_open_nav - nav) / this._state.day_open_nav
      : 0;
    const drawdownPct = this._state.hwm > 0
      ? (this._state.hwm - nav) / this._state.hwm
      : 0;

    const { open, reason } = await this.cb.isOpen();

    return {
      circuit_open:            open,
      circuit_reason:          reason,
      nav,
      hwm:                     this._state.hwm,
      daily_loss_pct:          dailyLossPct,
      drawdown_from_hwm_pct:   drawdownPct,
      rejections_today:        this._rejectionsToday,
      confidence_decay_factor: this.confidenceDecayFactor(),
      limits:                  RISK_LIMITS,
      checked_at:              Date.now(),
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async _computeNav(): Promise<number> {
    const positions = await this.positions.find({}).toArray();
    return positions.reduce((sum: number, p: any) => sum + (p.currentValue ?? 0), 0);
  }

  private async _logRejection(reason: string, detail: Record<string, unknown>): Promise<void> {
    this._rejectionsToday++;
    await this.rejections.insertOne({ timestamp: Date.now(), reason, detail });
  }

  private async _persistState(): Promise<void> {
    this._state.updated_at = new Date();
    await this.riskState.updateOne(
      { _id: 'singleton' },
      { $set: this._state },
      { upsert: true },
    );
  }

  private _today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private _dayStartMs(): number {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }
}
