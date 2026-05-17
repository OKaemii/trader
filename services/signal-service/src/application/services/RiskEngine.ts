import type { Collection, Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import { generateInternalToken } from '@trader/shared-auth';
import { sumPositionsGBP, type FxConverter, type PositionDoc } from '@trader/shared-portfolio';
import { CircuitBreakerRedis } from '../../infrastructure/CircuitBreakerRedis.ts';
import { RISK_LIMITS } from './LongOnlyOptimiser.ts';

const TRADING_SERVICE_URL = process.env.TRADING_SERVICE_URL ?? 'http://trading-service:3005';

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

  constructor(db: Db, redis: RedisClientType, private readonly fx: FxConverter) {
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

  // NAV in BASE_CURRENCY (GBP). Includes BOTH cash and positions:
  //   - positions: stored canonically as Money in the instrument currency by
  //     portfolio-service. GBP NAV is derived via sumPositionsGBP, which owns the
  //     single FX call. No dual-write, no currentValueGBP cache to drift from reality.
  //   - cash: HTTP-fetched from trading-service /internal/trading/cash; T212 reports GBP.
  //
  // If FX is unavailable past the 24h stale window, sumPositionsGBP throws and NAV
  // degrades to cash-only with a warning. Better than blocking every signal during a
  // transient Yahoo outage; the alternative (silently substituting native scalars for
  // GBP) was the 2026-05-15 bug class this rewrite retires.
  //
  // If cash fetch fails we degrade to positions-only with a warning.
  private async _computeNav(): Promise<number> {
    const positions = await this.positions.find({}).toArray() as unknown as PositionDoc[];
    let positionsGBP = 0;
    try {
      positionsGBP = await sumPositionsGBP(positions, this.fx);
    } catch (err) {
      console.warn('[RiskEngine] FX unavailable for NAV, degrading to cash-only:', err);
    }

    let cashGBP = 0;
    try {
      const res = await fetch(`${TRADING_SERVICE_URL}/internal/trading/cash`, {
        headers: { 'X-Internal-Token': generateInternalToken('signal-service') },
      });
      if (res.ok) {
        // Wire format post-FX-fix: { free: { amount, currency }, total: { amount, currency } }.
        // total includes invested capital + free cash; we want free + positions to avoid
        // double-counting (positions are already in positionsGBP).
        const body = await res.json() as { free?: { amount?: number; currency?: string } };
        if (body.free && typeof body.free.amount === 'number' && body.free.currency === 'GBP') {
          cashGBP = body.free.amount;
        } else {
          console.warn('[RiskEngine] cash response missing GBP free amount, using 0:', body);
        }
      } else {
        console.warn(`[RiskEngine] cash HTTP ${res.status}, NAV degrades to positions-only`);
      }
    } catch (err) {
      console.warn('[RiskEngine] cash fetch failed, NAV degrades to positions-only:', err);
    }

    return positionsGBP + cashGBP;
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
