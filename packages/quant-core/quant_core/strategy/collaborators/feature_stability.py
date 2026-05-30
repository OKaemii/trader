"""
FeatureStabilityReport — per-feature coefficient of variation + ADF stationarity flag.

Run at every rebalance cycle. If a feature's CV exceeds the threshold or it fails the
ADF stationarity test, it is flagged for review. Flagged features are down-weighted in
the composite score (handled by the calling strategy).

The report is attached to StrategyOutput and written to the feature store on every cycle.
"""
from dataclasses import dataclass, field
import numpy as np


@dataclass
class FeatureStats:
    name: str
    mean: float
    std: float
    cv: float                 # coefficient of variation = std / |mean|
    is_stationary: bool       # True if ADF p-value < 0.05 (or series too short to test → True)
    n_obs: int


@dataclass
class FeatureStabilityReport:
    features: list[FeatureStats] = field(default_factory=list)
    n_unstable: int = 0       # features with CV > CV_THRESHOLD or non-stationary
    stability_score: float = 1.0  # fraction of features that are stable [0, 1]

    def is_stable(self, feature_name: str) -> bool:
        for f in self.features:
            if f.name == feature_name:
                return f.is_stationary and f.cv < FeatureStabilityAnalyser.CV_THRESHOLD
        return True  # unknown features default to stable


class FeatureStabilityAnalyser:
    CV_THRESHOLD = 2.0   # CV above this → unstable (signal noise exceeds signal level)
    MIN_OBS      = 20    # minimum observations before computing stability

    def analyse(self, feature_series: dict[str, list[float]]) -> FeatureStabilityReport:
        """
        feature_series: dict mapping feature name → list of recent scalar values (time-ordered).
        Returns a FeatureStabilityReport.
        """
        stats: list[FeatureStats] = []

        for name, values in feature_series.items():
            arr = np.array(values, dtype=float)
            n = len(arr)
            if n < 2:
                stats.append(FeatureStats(
                    name=name, mean=float(arr[0]) if n == 1 else 0.0,
                    std=0.0, cv=0.0, is_stationary=True, n_obs=n,
                ))
                continue

            mean = float(np.mean(arr))
            std  = float(np.std(arr, ddof=1))
            cv   = std / (abs(mean) + 1e-8)

            # ADF stationarity — only if enough observations
            is_stationary = True
            if n >= self.MIN_OBS:
                is_stationary = self._adf_stationary(arr)

            stats.append(FeatureStats(
                name=name, mean=mean, std=std, cv=cv,
                is_stationary=is_stationary, n_obs=n,
            ))

        n_unstable = sum(
            1 for f in stats
            if f.cv >= self.CV_THRESHOLD or not f.is_stationary
        )
        stability_score = 1.0 - (n_unstable / max(len(stats), 1))

        return FeatureStabilityReport(
            features=stats,
            n_unstable=n_unstable,
            stability_score=stability_score,
        )

    @staticmethod
    def _adf_stationary(arr: np.ndarray) -> bool:
        """Augmented Dickey-Fuller test. Returns True if series is stationary (p < 0.05)."""
        try:
            from statsmodels.tsa.stattools import adfuller
            result = adfuller(arr, autolag='AIC', regression='c')
            p_value = result[1]
            return bool(p_value < 0.05)
        except ImportError:
            # statsmodels not available — skip test, assume stationary
            return True
        except Exception:
            return True
