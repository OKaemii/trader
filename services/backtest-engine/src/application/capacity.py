from dataclasses import dataclass, field
from enum import Enum
import numpy as np


class LiquidityTier(Enum):
    TIER_1   = 'tier_1'    # ADV > $50M USD — large cap, liquid
    TIER_2   = 'tier_2'    # ADV $10M–$50M — mid cap
    TIER_3   = 'tier_3'    # ADV $1M–$10M — small cap, use with caution
    EXCLUDED = 'excluded'  # ADV < $1M — never trade


@dataclass
class CapacityReport:
    aum_target_usd: float
    universe_size: int
    effective_universe: int
    max_single_position_usd: float
    rebalance_frequency_days: int
    estimated_annual_cost_bps: float
    alpha_half_life_days: float
    capacity_sufficient: bool
    crowding_suspected: bool
    notes: list[str] = field(default_factory=list)


def classify_liquidity_tier(adv_usd: float) -> LiquidityTier:
    if adv_usd >= 50_000_000: return LiquidityTier.TIER_1
    if adv_usd >= 10_000_000: return LiquidityTier.TIER_2
    if adv_usd >= 1_000_000:  return LiquidityTier.TIER_3
    return LiquidityTier.EXCLUDED


def estimate_capacity(
    universe_adv: list[float],
    aum_target_usd: float,
    adv_participation_cap: float = 0.05,
    rebalance_frequency_days: int = 1,
) -> CapacityReport:
    eligible = [adv for adv in universe_adv if classify_liquidity_tier(adv) != LiquidityTier.EXCLUDED]
    max_position_per_name = [adv * adv_participation_cap for adv in eligible]
    total_capacity = sum(max_position_per_name)
    notes = []
    if aum_target_usd > total_capacity * 0.5:
        notes.append(f'AUM target ${aum_target_usd:,.0f} is >50% of capacity ${total_capacity:,.0f} — expect material market impact')
    if rebalance_frequency_days == 1 and len(eligible) < 20:
        notes.append('Daily rebalance with < 20 names: extremely high per-name turnover')
    if len(eligible) > 60:
        notes.append(f'Universe {len(eligible)} names exceeds 60-name initial target')
    return CapacityReport(
        aum_target_usd=aum_target_usd,
        universe_size=len(universe_adv),
        effective_universe=len(eligible),
        max_single_position_usd=max(max_position_per_name) if max_position_per_name else 0,
        rebalance_frequency_days=rebalance_frequency_days,
        estimated_annual_cost_bps=0.0,
        alpha_half_life_days=0.0,
        capacity_sufficient=aum_target_usd <= total_capacity,
        crowding_suspected=False,
        notes=notes,
    )


def crowding_indicators(
    signal_hit_rate_rolling: np.ndarray,
    ic_rolling: np.ndarray,
    turnover_rolling: np.ndarray,
) -> dict:
    ic_trend = float(np.polyfit(np.arange(len(ic_rolling)), ic_rolling, 1)[0])
    hr_trend = float(np.polyfit(np.arange(len(signal_hit_rate_rolling)), signal_hit_rate_rolling, 1)[0])
    to_trend = float(np.polyfit(np.arange(len(turnover_rolling)), turnover_rolling, 1)[0])
    return {
        'ic_declining':         ic_trend < -0.001,
        'hit_rate_below_50pct': float(signal_hit_rate_rolling[-1]) < 0.50,
        'turnover_creeping':    to_trend > 0.005,
        'crowding_suspected':   ic_trend < -0.001 and float(signal_hit_rate_rolling[-1]) < 0.52,
    }


def capacity_ceiling_test(
    gross_sharpe: float,
    post_cost_sharpe_at_current_aum: float,
    post_cost_sharpe_at_target_aum: float,
    min_acceptable_sharpe: float = 0.5,
) -> dict:
    margin     = post_cost_sharpe_at_current_aum - min_acceptable_sharpe
    new_margin = post_cost_sharpe_at_target_aum - min_acceptable_sharpe
    return {
        'safe_to_scale':    new_margin > 0,
        'margin_shrinkage': f'{margin:.2f} → {new_margin:.2f}',
        'warning': (
            'Low margin — strategy near capacity ceiling; scaling risks pushing below threshold'
            if new_margin < 0.15 else None
        ),
    }
