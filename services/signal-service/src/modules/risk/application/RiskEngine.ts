import type { Collection, Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import type { Logger } from '@trader/core';
import type { TradingServiceClient } from '@trader/contracts';
import { sumPositionsGBP, type FxConverter, type PositionDoc } from '@trader/shared-portfolio';
import { CircuitBreakerRedis } from '../infrastructure/CircuitBreakerRedis.ts';
import { OperatorControls } from '../infrastructure/OperatorControls.ts';
import { RiskLimitsProvider, type RiskLimits, type RiskLimitsOverride } from '../infrastructure/RiskLimitsProvider.ts';
import { RISK_LIMITS } from '../../signals/application/LongOnlyOptimiser.ts';
import type { TripRecorder, TripContext } from './TripRecorder.ts';
import type { ISignalRepository } from '../../signals/domain/ISignalRepository.ts';
import { SignalFailureReason } from '@trader/shared-types';

export interface RiskStatus {
  circuit_open: boolean;
  circuit_reason: string | null;
  nav: number;
  hwm: number;
  daily_loss_pct: number;
  drawdown_from_hwm_pct: number;
  rejections_today: number;
  confidence_decay_factor: number;  // 1.0 = fresh model, 0.0 = stale (>120 days)
  limits: RiskLimits;               // effective (overrides overlaid on RISK_LIMITS defaults)
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
  private readonly ops: OperatorControls;
  private readonly riskLimits: RiskLimitsProvider;

  private _state: RiskState = {
    _id: 'singleton',
    hwm: 0,
    day_open_nav: 0,
    day_date: '',
    last_retrain_ts: 0,
    updated_at: new Date(),
  };

  private _rejectionsToday = 0;

  // Optional collaborators wired by signal-service for the auto-drain + post-mortem
  // behaviour. Left optional so unit tests and alternate constructions don't have to
  // build the whole stack — when absent, canTrade still trips the breaker but skips
  // the drain + record steps.
  private signalRepo?: ISignalRepository;
  private tripRecorder?: TripRecorder;

  constructor(
    db: Db,
    redis: RedisClientType,
    private readonly fx: FxConverter,
    private readonly trading: TradingServiceClient,
    private readonly logger: Logger,
  ) {
    this.rejections = db.collection('risk_rejections');
    this.riskState  = db.collection<RiskState>('risk_state');
    this.positions  = db.collection('positions');
    this.cb         = new CircuitBreakerRedis(redis);
    this.ops        = new OperatorControls(redis);
    this.riskLimits = new RiskLimitsProvider(db, logger);
  }

  // Wired post-construction because TripRecorder needs the signal repo, and the repo
  // is built in the same wiring step. Avoids a circular constructor dependency.
  attachTripPipeline(signalRepo: ISignalRepository, tripRecorder: TripRecorder): void {
    this.signalRepo = signalRepo;
    this.tripRecorder = tripRecorder;
  }

  async init(): Promise<void> {
    const saved = await this.riskState.findOne({ _id: 'singleton' });
    if (saved) this._state = saved;

    const today = this._today();
    if (this._state.day_date !== today) {
      const { nav, complete } = await this._computeNav();
      // Only baseline day_open_nav from a COMPLETE reading. An incomplete reading
      // (cash fetch failed, etc.) would freeze a degraded baseline that biases
      // every subsequent daily-loss calc downward. Better to defer setting it —
      // canTrade() will pick up the first complete reading and set the baseline
      // lazily on the same-day path.
      if (complete) {
        this._state.day_open_nav = nav;
      } else {
        this.logger.warn({ nav }, 'init: NAV reading incomplete, deferring day_open_nav baseline to first clean reading');
        this._state.day_open_nav = 0;   // sentinel: "no valid baseline yet"
      }
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
    // Operator halts first — distinct from (and independent of) the automatic NAV breaker.
    const ops = await this.ops.state();
    if (ops.killSwitch) return { allowed: false, reason: 'kill_switch engaged' };
    if (ops.paused)     return { allowed: false, reason: 'strategy paused' };
    // Redis-backed circuit breaker check
    const { open, reason: cbReason } = await this.cb.isOpen();
    if (open) return { allowed: false, reason: cbReason ?? 'Circuit breaker tripped' };

    const { nav, complete } = await this._computeNav();

    // Skip the loss/drawdown gates when NAV is degraded. Comparing an incomplete
    // reading against the persisted day_open_nav produces the 100% phantom-loss
    // trip. We still allow the trade — the dispatcher's own pre-place checks
    // (cash, drift) catch real broker-state problems with first-hand data.
    if (!complete) {
      this.logger.warn({ nav }, 'canTrade: NAV reading incomplete, skipping daily-loss + drawdown gates');
      return { allowed: true, reason: null };
    }

    if (this._state.hwm === 0) {
      this._state.hwm = nav;
      this._state.day_open_nav = nav;
      await this._persistState();
    }

    // Lazy baseline: init() defers day_open_nav when NAV was incomplete at boot.
    // First complete reading of the day sets it here.
    if (this._state.day_open_nav === 0 && nav > 0) {
      this._state.day_open_nav = nav;
      await this._persistState();
      this.logger.info({ nav }, 'canTrade: established day_open_nav baseline from first complete reading');
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

    // Operator-tunable halt thresholds (portal_risk_config); 15s-cached overlay on RISK_LIMITS.
    const limits = await this.riskLimits.effective();

    if (dailyLossPct > limits.maxDailyLoss) {
      const reasonText = `Daily loss ${(dailyLossPct * 100).toFixed(2)}% exceeds ${(limits.maxDailyLoss * 100).toFixed(0)}% limit`;
      await this._onTrip({
        reason: 'DAILY_LOSS_HALT', reasonText,
        nav, hwm: this._state.hwm, dayOpenNav: this._state.day_open_nav,
        dailyLossPct, drawdownPct,
      });
      return { allowed: false, reason: reasonText };
    }

    if (drawdownPct > limits.maxDrawdownHalt) {
      const reasonText = `Drawdown ${(drawdownPct * 100).toFixed(2)}% exceeds ${(limits.maxDrawdownHalt * 100).toFixed(0)}% HWM limit`;
      await this._onTrip({
        reason: 'DRAWDOWN_HALT', reasonText,
        nav, hwm: this._state.hwm, dayOpenNav: this._state.day_open_nav,
        dailyLossPct, drawdownPct,
      });
      return { allowed: false, reason: reasonText };
    }

    return { allowed: true, reason: null };
  }

  async resetCircuitBreaker(): Promise<void> {
    await this.cb.reset();
  }

  // ── Operator controls (kill switch + pause) — see OperatorControls ────────────────
  async operatorState(): Promise<{ killSwitch: boolean; paused: boolean }> {
    return this.ops.state();
  }

  async setKillSwitch(on: boolean): Promise<void> {
    await this.ops.setKillSwitch(on);
    this.logger.warn({ on }, on ? 'KILL SWITCH ENGAGED — halting new emission + dispatcher drain' : 'kill switch released');
  }

  async setPaused(on: boolean): Promise<void> {
    await this.ops.setPaused(on);
    this.logger.warn({ on }, on ? 'strategy emission PAUSED' : 'strategy emission resumed');
  }

  // ── Risk limits (operator-tunable, hot via portal_risk_config) ────────────────────
  /** Effective limits used by the optimiser caps + circuit-breaker thresholds (15s-cached). */
  async effectiveLimits(): Promise<RiskLimits> {
    return this.riskLimits.effective();
  }

  /** Admin read: effective + raw overrides + compile-time defaults + tunable field list + bounds. */
  async riskLimitsView() {
    const [effective, overrides] = await Promise.all([
      this.riskLimits.effective(),
      this.riskLimits.overrides(),
    ]);
    return { effective, overrides, ...this.riskLimits.defaults() };
  }

  /** Admin write: validate + persist overrides, drop cache, return the new effective limits. */
  async setRiskLimits(next: RiskLimitsOverride): Promise<{ effective: RiskLimits; overrides: RiskLimitsOverride }> {
    const result = await this.riskLimits.setOverrides(next);
    this.logger.warn({ overrides: result.overrides }, 'risk limits updated from portal');
    return result;
  }

  /** Drop the local cache — called from the config:invalidated subscription (cross-pod refresh). */
  invalidateRiskLimits(): void {
    this.riskLimits.invalidate();
  }

  // Public NAV accessor — used by GenerateSignals to scale `top_k` with portfolio size.
  // Returns 0 when the underlying read is incomplete (cash fetch failed, FX unavailable);
  // callers must treat that as "no signal" and fall back to the strategy-emitted top_k.
  // This is a deliberate second read per cycle on top of canTrade()'s NAV fetch — generate
  // cycles fire every 5min so the cost (one Mongo aggregation + one HTTP) is negligible
  // versus the architectural cost of threading NAV through canTrade()'s return shape.
  async currentNavGBP(): Promise<number> {
    const { nav, complete } = await this._computeNav();
    return complete ? nav : 0;
  }

  async logRejection(reason: string, detail: Record<string, unknown>): Promise<void> {
    await this._logRejection(reason, detail);
  }

  async status(): Promise<RiskStatus> {
    const { nav } = await this._computeNav();
    const dailyLossPct = this._state.day_open_nav > 0
      ? (this._state.day_open_nav - nav) / this._state.day_open_nav
      : 0;
    const drawdownPct = this._state.hwm > 0
      ? (this._state.hwm - nav) / this._state.hwm
      : 0;

    const { open, reason } = await this.cb.isOpen();
    const limits = await this.riskLimits.effective();

    return {
      circuit_open:            open,
      circuit_reason:          reason,
      nav,
      hwm:                     this._state.hwm,
      daily_loss_pct:          dailyLossPct,
      drawdown_from_hwm_pct:   drawdownPct,
      rejections_today:        this._rejectionsToday,
      confidence_decay_factor: this.confidenceDecayFactor(),
      limits,
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
  // Returns `{ nav, complete }` — `complete=false` when either source silently
  // degraded (cash fetch failed, FX unavailable, etc.). Callers must NOT compare a
  // degraded reading against the persisted `day_open_nav`: doing so produced the
  // 100% phantom-loss circuit trip we saw when trading-service was unreachable
  // (positions=0 + cash fetch error → nav=0 vs persisted day_open_nav=X → 100% loss).
  //
  // If cash fetch fails we degrade to positions-only with a warning AND mark incomplete.
  // If positions FX conversion fails we degrade to cash-only AND mark incomplete.
  // If both succeed AND positions table is empty AND cash is genuinely 0, that's a
  // "real zero" — `complete=true`, NAV=0 is a legitimate reading (paper mode, fresh
  // account, etc.). The day_open_nav check below treats that as "no comparison
  // baseline" if day_open_nav was also 0, or "real loss" if it was positive.
  private async _computeNav(): Promise<{ nav: number; complete: boolean }> {
    // NAV comes from T212's `cash.total` — the broker's authoritative figure that already
    // includes free + blocked + invested + ppl + pieCash. Previously we summed cash.free
    // (free cash only) + our own positions-from-Mongo, which silently dropped the
    // `blocked` reserve T212 holds for our pending orders. With one weekly rebalance
    // worth of pending orders blocked, that under-counted NAV by ~£1.6k on a £6k
    // account → daily-loss gate read 19% → breaker thrashed on a phantom loss while
    // the actual portfolio was flat. T212's total is fed by the same fills + market
    // marks the portal displays, so RiskEngine + portal now agree by construction.
    //
    // Our own sumPositionsGBP is still computed for the COMPLETENESS check: if the
    // independent view disagrees materially with T212's total we mark NAV incomplete
    // and skip the gates rather than gate on numbers we can't reconcile.
    const positions = await this.positions.find({}).toArray() as unknown as PositionDoc[];
    let positionsGBP = 0;
    let positionsOk = true;
    try {
      positionsGBP = await sumPositionsGBP(positions, this.fx);
    } catch (err) {
      this.logger.warn({ err }, 'FX unavailable for cross-check (NAV reading INCOMPLETE)');
      positionsOk = false;
    }

    let navGBP = 0;
    let cashOk = true;
    try {
      const cash = await this.trading.getCash();
      if (cash.total.currency === 'GBP') {
        navGBP = cash.total.amount;
      } else {
        this.logger.warn({ currency: cash.total.currency }, 'cash response not in GBP (NAV reading INCOMPLETE)');
        cashOk = false;
      }
    } catch (err) {
      this.logger.warn({ err }, 'cash fetch failed (NAV reading INCOMPLETE)');
      cashOk = false;
    }

    return { nav: navGBP, complete: positionsOk && cashOk };
  }

  // Single trip transition. Order matters:
  //   1. Flip the Redis flag so any concurrent generate cycle short-circuits immediately.
  //   2. Bulk-cancel BUYs in {pending, approved, queued}. SELLs stay — they're typically
  //      risk-exits and we never want to block the deleveraging path the breaker is meant
  //      to encourage. `executing` rows are left to FillsPoller (racing T212 is worse).
  //   3. Capture the post-mortem snapshot (incl. the cancelled ids).
  //   4. risk_rejections log entry (preserves the older log shape — pre-existing dashboards).
  // Each step is best-effort: failures are logged but never block the next step. The
  // breaker MUST end up tripped even if Mongo writes throw.
  private async _onTrip(ctx: TripContext): Promise<void> {
    await this.cb.trip(ctx.reasonText);

    let cancelledIds: string[] = [];
    if (this.signalRepo) {
      try {
        cancelledIds = await this.signalRepo.bulkCancelOpenBuys(
          SignalFailureReason.AutoCancelledCircuitBreaker,
          `auto-drain on ${ctx.reason}: ${ctx.reasonText}`,
        );
        this.logger.warn({ reason: ctx.reason, cancelled: cancelledIds.length },
          'circuit-breaker auto-drain: cancelled open BUYs');
      } catch (err) {
        this.logger.error({ err }, 'circuit-breaker auto-drain failed (breaker still tripped)');
      }
    } else {
      this.logger.warn('circuit-breaker tripped but signalRepo not attached — skipping auto-drain');
    }

    if (this.tripRecorder) {
      try { await this.tripRecorder.capture(ctx, cancelledIds); }
      catch (err) {
        this.logger.error({ err }, 'trip recorder failed (breaker still tripped, drain still ran)');
      }
    }

    await this._logRejection(ctx.reason, {
      dailyLossPct: ctx.dailyLossPct, drawdownPct: ctx.drawdownPct,
      nav: ctx.nav, hwm: ctx.hwm, cancelled: cancelledIds.length,
    });
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
