"""Wire types shared by live (strategy-engine) and replay (backtest-engine).

Mirrors the contract signal-service consumes on `signals:strategy`. Moved here from
strategy-engine/src/domain/dataclasses.py so there is exactly one definition.
"""
from dataclasses import dataclass
from typing import Optional


@dataclass
class OHLCVBar:
    ticker: str
    timestamp: int          # Unix ms
    open: float
    high: float
    low: float
    close: float
    volume: float
    raw_close: Optional[float] = None         # unadjusted price; set when adjustment_factor != 1
    adjusted_close: Optional[float] = None
    adjustment_factor: Optional[float] = None


@dataclass
class StrategyOutput:
    timestamp: int                                    # Unix ms
    strategy_id: str                                  # e.g. 'factor_rank_v1', 'topology_v1'
    ticker_universe: list[str]
    composite_scores: dict[str, float]                # ticker → ranked score (higher = more bullish)
    factor_attributions: dict[str, dict[str, float]]  # ticker → {factor: contribution}
    sectors: dict[str, str]                           # ticker → GICS sector
    covariance_matrix: list[list[float]]              # shrunk covariance (Ledoit-Wolf)
    regime_confidence: float                          # [0,1] stability of current regime
    position_size_multiplier: float = 1.0             # from RegimeState; applied in signal-service
    signal_weights: Optional[dict] = None             # from RegimeState; factor → weight
    feature_stability: Optional[dict] = None          # FeatureStabilityReport as dict
    # Optional topology extras — only present when strategy_id starts with 'topology_'
    betti_curves: Optional[dict] = None
    persistence_pairs: Optional[list] = None
    laplacian_residuals: Optional[dict[str, float]] = None
    # Reporting cadence — drives the notification-service CycleAnalysisBatcher window.
    report_cadence: str = 'per_cycle'
    # Top-K positions the optimiser is allowed to hold (0 = no truncation).
    top_k: int = 0
    # Sizing intent honoured by the optimiser: 'score_proportional' (default — solve_long_only)
    # or 'inverse_vol' (w_i ∝ 1/σ_i over the emitted held set; high_velocity_v1).
    weighting: str = 'score_proportional'
