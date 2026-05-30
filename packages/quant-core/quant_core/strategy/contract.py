"""The single strategy contract shared by live emission and backtest replay.

A strategy is a structural `Strategy` (Protocol) — implementations do NOT inherit a base
class (no ABC), so there is no concrete base to derive from or override. Shared behaviour is
composed in (factors, regime engine, stability analyser, covariance estimator); see
`factors.py` and `collaborators/`.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol, runtime_checkable

from ..types import StrategyOutput


@dataclass(frozen=True)
class HistoryView:
    """A pure, oldest-first view of bar history. No I/O — the host fetches and hands it in."""
    closes: dict[str, list[float]]
    volumes: dict[str, list[float]]
    timestamps: dict[str, list[int]]


@dataclass(frozen=True)
class StrategyParams:
    """Hyper-parameters swept by grid search; the live host passes the strategy's defaults."""
    values: dict[str, float]

    def get(self, key: str, default: float) -> float:
        return self.values.get(key, default)


@dataclass(frozen=True)
class FeatureVector:
    """Everything `decide` needs, computed purely from a HistoryView at one observation_ts.

    - `composite_scores[t]` is the rankable score the optimiser sorts on.
    - `per_ticker[t]` is the factor-attribution map (the exact shape published in
      StrategyOutput.factor_attributions).
    - `extras` carries strategy-specific payload that not every strategy produces — e.g.
      topology's betti_curves / persistence_pairs / laplacian_residuals — so the core type
      stays generic (Open/Closed: extend via extras, never edit FeatureVector per strategy).
    """
    strategy_id: str
    observation_ts: int
    ticker_universe: list[str]
    composite_scores: dict[str, float]
    per_ticker: dict[str, dict[str, float]]
    cross_sectional_stats: dict[str, float]
    regime_confidence: float
    position_size_multiplier: float
    signal_weights: Optional[dict]
    sectors: dict[str, str]
    covariance_matrix: list[list[float]]
    feature_stability: Optional[dict]
    extras: Optional[dict] = None


@dataclass(frozen=True)
class PortfolioState:
    current_weights: dict[str, float]
    nav: float
    cash: float


@dataclass(frozen=True)
class StrategyConfig:
    """Per-strategy config the strategy *holds* (never an overridden base concrete)."""
    strategy_id: str
    rolling_window: int
    min_universe_size: int
    report_cadence: str
    top_k: int = 0
    # How many historical cycles the live host replays at boot to warm cross-cycle
    # collaborator state (RegimeEngine / FeatureStabilityAnalyser). Phase 1 makes those
    # stateless (window read from the FeatureStore) and this drops to 0 everywhere.
    prewarm_cycles: int = 0


@runtime_checkable
class Strategy(Protocol):
    config: StrategyConfig

    def parameter_space(self) -> dict[str, list[float]]:
        """Discrete hyper-parameter grid for in-sample fit / MCPT. {} = no tunables."""
        ...

    def compute_features(
        self, history: HistoryView, as_of_ms: int, params: StrategyParams
    ) -> Optional[FeatureVector]:
        """Pure: bars-as-of → features. None when the universe is too thin to act."""
        ...

    def decide(
        self, features: FeatureVector, portfolio: PortfolioState
    ) -> Optional[StrategyOutput]:
        """Pure: features + portfolio → emission. None when nothing to emit."""
        ...
