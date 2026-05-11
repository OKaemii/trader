from dataclasses import dataclass, field
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
    # Optional topology extras — only present when strategy_id starts with 'topology_'
    betti_curves: Optional[dict] = None
    persistence_pairs: Optional[list] = None
    laplacian_residuals: Optional[dict[str, float]] = None
