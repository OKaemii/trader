// RiskLimitsProvider — reads operator-tunable risk limits from MongoDB
// (portal_risk_config.overrides), overlays them onto the RISK_LIMITS compile-time defaults, caches
// for 15s, and falls back to the defaults on any miss. Subscribed (via wiring) to the
// `config:invalidated` pubsub topic so a portal save drops the cache instantly instead of waiting
// on the TTL. This is what lets the operator retune the circuit-breaker thresholds + optimiser
// caps from the portal without restarting signal-service.
//
// Only the OPERATOR-TUNABLE subset is overridable here. The other RISK_LIMITS fields are either
// structural (confidenceStaleDays = model-retrain cadence) or already live via env
// (volatilityTarget ← VOL_TARGET, minConfidence ← MIN_ACTIONABLE_CONFIDENCE) — overriding those
// belongs elsewhere, not in this doc. Each field is independent: an absent/invalid override field
// falls back to the compile-time default for just that field (precedence: override > default).

import type { Db } from 'mongodb';
import type { Logger } from '@trader/core';
import { COLLECTIONS } from '@trader/shared-mongo';
import { RISK_LIMITS } from '../../signals/application/LongOnlyOptimiser.ts';

// Runtime limits: same keys as RISK_LIMITS but number-valued (overrides widen the `as const`
// literal types — the reported/effective values are arbitrary fractions, not the compile-time ones).
export type RiskLimits = { [K in keyof typeof RISK_LIMITS]: number };

// The subset an operator may retune at runtime. Each is a fraction; see BOUNDS for the accepted
// range. Anything outside the range is rejected on write (fail-closed → keeps the prior value).
export const TUNABLE_RISK_FIELDS = [
  'maxDailyLoss',
  'maxDrawdownHalt',
  'maxSingleName',
  'maxSectorConcentration',
  'maxWeeklyTurnover',
] as const;
export type TunableRiskField = (typeof TUNABLE_RISK_FIELDS)[number];
export type RiskLimitsOverride = Partial<Record<TunableRiskField, number>>;

// Inclusive [min, max] accepted per field. Bounds are deliberately wide (the operator owns the
// risk decision) but reject negatives/zero/NaN and physically nonsensical values (e.g. a 500%
// daily-loss halt). The portal editor surfaces sensible defaults inside these.
const BOUNDS: Record<TunableRiskField, readonly [number, number]> = {
  maxDailyLoss:           [0.005, 0.50],   //  0.5%–50% intraday loss halt
  maxDrawdownHalt:        [0.01,  0.80],   //    1%–80% drawdown-from-HWM halt
  maxSingleName:          [0.01,  1.00],   //    1%–100% max weight per name
  maxSectorConcentration: [0.05,  1.00],   //    5%–100% max weight per GICS sector
  maxWeeklyTurnover:      [0.01,  5.00],   //    1%–500% weekly turnover budget
};

interface RiskConfigDoc {
  _id: 'singleton';
  overrides: RiskLimitsOverride;
  updatedAt: Date;
}

const CACHE_MS = 15_000;

export class RiskLimitsProvider {
  private cached: { value: RiskLimits; ts: number } | null = null;

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly base: RiskLimits = RISK_LIMITS,
  ) {}

  /** Effective limits = stored overrides overlaid on the compile-time defaults. 15s cached. */
  async effective(): Promise<RiskLimits> {
    if (this.cached && Date.now() - this.cached.ts < CACHE_MS) return this.cached.value;
    const value = this._merge(await this._readOverrides());
    this.cached = { value, ts: Date.now() };
    return value;
  }

  /** Raw stored overrides (only the fields the operator has set). Uncached — admin read path. */
  async overrides(): Promise<RiskLimitsOverride> {
    return this._readOverrides();
  }

  /** Persist a new override set (validated + bounded), drop the local cache, return the new
   * effective limits. Invalid fields are dropped (not clamped) so the prior default stands. */
  async setOverrides(next: RiskLimitsOverride): Promise<{ effective: RiskLimits; overrides: RiskLimitsOverride }> {
    const clean = this._sanitize(next);
    await this.db.collection<RiskConfigDoc>(COLLECTIONS.PORTAL_RISK_CONFIG).updateOne(
      { _id: 'singleton' },
      { $set: { overrides: clean, updatedAt: new Date() } },
      { upsert: true },
    );
    this.invalidate();
    return { effective: this._merge(clean), overrides: clean };
  }

  /** The compile-time defaults + the tunable field list + bounds — for the portal editor. */
  defaults(): { defaults: RiskLimits; tunableFields: readonly TunableRiskField[]; bounds: typeof BOUNDS } {
    return { defaults: this.base, tunableFields: TUNABLE_RISK_FIELDS, bounds: BOUNDS };
  }

  invalidate(): void {
    this.cached = null;
  }

  private async _readOverrides(): Promise<RiskLimitsOverride> {
    try {
      const doc = await this.db
        .collection<RiskConfigDoc>(COLLECTIONS.PORTAL_RISK_CONFIG)
        .findOne({ _id: 'singleton' }, { projection: { overrides: 1 } });
      return this._sanitize(doc?.overrides ?? {});
    } catch (err) {
      this.logger.warn({ err }, 'risk-limits: mongo read failed, using compile-time defaults');
      return {};
    }
  }

  private _merge(o: RiskLimitsOverride): RiskLimits {
    const out: Record<string, number> = { ...this.base };
    for (const f of TUNABLE_RISK_FIELDS) {
      const v = o[f];
      if (typeof v === 'number' && Number.isFinite(v)) out[f] = v;
    }
    return out as RiskLimits;
  }

  private _sanitize(o: RiskLimitsOverride): RiskLimitsOverride {
    const out: RiskLimitsOverride = {};
    for (const f of TUNABLE_RISK_FIELDS) {
      const v = o[f];
      const [lo, hi] = BOUNDS[f];
      if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) out[f] = v;
    }
    return out;
  }
}
