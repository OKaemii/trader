import numpy as np
from dataclasses import dataclass


@dataclass
class RegimeState:
    confidence: float           # [0,1] — 1 = stable, 0 = crisis; drives position_size_multiplier
    trend_score: float          # rolling 63-day index return (positive = uptrend)
    volatility_z: float         # realised vol relative to historical average
    dispersion: float           # cross-sectional return dispersion
    correlation_stability: float  # Frobenius distance of corr matrix from previous period
    # Derived soft multipliers (continuous, no binary enable/disable)
    position_size_multiplier: float = 1.0   # in [0.25, 1.0]; scales all position sizes
    signal_weights: dict = None             # factor → weight; topology weight → 0 in crisis

    def __post_init__(self) -> None:
        # position_size_multiplier: minimum 25% in crisis, full in stable regime
        self.position_size_multiplier = 0.25 + 0.75 * self.confidence
        # Signal weights: topology contribution fades below confidence 0.6
        topo_w  = max(0.0, (self.confidence - 0.6) / 0.4)
        base_w  = 1.0 - topo_w * 0.2          # momentum/reversal take the remaining share
        self.signal_weights = {
            'momentum': round(base_w * 0.55, 4),
            'reversal':  round(base_w * 0.45, 4),
            'topology':  round(topo_w * 0.20, 4),
        }


class RegimeEngine:
    """
    Soft probabilistic regime classifier.

    Uses a composite score of volatility, trend, dispersion, and correlation
    stability to produce a continuous regime_confidence in [0,1].
    High confidence (≈ 1) = stable benign market (full position sizing).
    Low confidence (≈ 0) = unstable/crisis (reduced position sizing).

    Position sizing in the signal service scales by: regime_confidence.

    Warm-up: the engine needs ≥ WINDOW_VOL cross-sectional return vectors before it
    produces a non-sentinel confidence. The strategy-engine host runs a historical
    prewarm pass at boot that feeds 2× HISTORY_MIN vectors before the first live cycle —
    so steady state is reached on cycle 1, not cycle 22. No Redis persistence needed:
    every boot recomputes deterministically from the bar history.

    NOTE: In Phase 1 of the quant-grade-strategy-lifecycle plan this engine becomes
    stateless — `assess(returns, prior_means, prior_vectors)` reading its window from the
    FeatureStore instead of holding `_mean_history` / `_corr_window`. For now it preserves
    the live behaviour so the Phase 0 parity gate holds.
    """

    WINDOW_TREND = 63   # trading days for trend estimation
    WINDOW_VOL   = 21   # trading days for realised vol
    HISTORY_MIN  = 63   # minimum history required

    def __init__(self) -> None:
        self._mean_history: list[float] = []
        self._corr_window: list[np.ndarray] = []
        self._prev_corr: np.ndarray | None = None

    def update(self, cross_sectional_returns: np.ndarray) -> RegimeState:
        """
        cross_sectional_returns: shape (n_assets,) for the current period.
        Returns RegimeState with confidence score and component metrics.
        """
        n_assets = len(cross_sectional_returns)
        if n_assets == 0:
            return RegimeState(confidence=0.5, trend_score=0.0, volatility_z=0.0,
                               dispersion=0.0, correlation_stability=0.0)

        # Universe-invariant: scalar mean return per cycle.
        self._mean_history.append(float(cross_sectional_returns.mean()))
        if len(self._mean_history) > self.HISTORY_MIN * 2:
            self._mean_history.pop(0)

        # Correlation window: requires consistent n_assets across the window. Reset on
        # any change rather than retain stale corr from a different universe.
        if self._corr_window and len(self._corr_window[0]) != n_assets:
            self._corr_window.clear()
            self._prev_corr = None
        self._corr_window.append(cross_sectional_returns.copy())
        if len(self._corr_window) > self.WINDOW_VOL:
            self._corr_window.pop(0)

        if len(self._mean_history) < self.WINDOW_VOL:
            return RegimeState(confidence=0.5, trend_score=0.0, volatility_z=0.0,
                               dispersion=0.0, correlation_stability=0.0)

        market_returns = np.asarray(self._mean_history, dtype=float)

        # Trend: rolling 63-day cumulative index return
        trend_window = min(self.WINDOW_TREND, len(market_returns))
        trend_score = float(market_returns[-trend_window:].sum())

        # Volatility z-score: recent 21-day vol relative to full history
        vol_recent = float(market_returns[-self.WINDOW_VOL:].std())
        vol_history = float(market_returns.std()) if len(market_returns) > 30 else vol_recent
        vol_z = (vol_recent - vol_history) / (vol_history + 1e-8)

        # Dispersion: cross-sectional std of returns today (scalar from the current cycle —
        # no history needed, so universe-invariant by construction).
        dispersion = float(cross_sectional_returns.std())

        # Correlation stability: only when the corr window is full AND the universe has
        # been stable across it. After a reset (n_assets change), stability is 0 until the
        # window refills — that's the right answer ("undefined, no signal").
        stability = 0.0
        if len(self._corr_window) == self.WINDOW_VOL and n_assets >= 2:
            recent_mat = np.array(self._corr_window).T   # (n_assets, WINDOW_VOL)
            corr = np.corrcoef(recent_mat)
            if self._prev_corr is not None and self._prev_corr.shape == corr.shape:
                stability = float(np.linalg.norm(corr - self._prev_corr, 'fro'))
            self._prev_corr = corr.copy()

        # Soft confidence: logistic centred on (vol_z=0, stability=0) → 1.0 in calm markets,
        # decaying toward 0 as vol excess and correlation instability grow. Anchor offset 4.0
        # puts the calm-market sigmoid output near 0.98.
        k_v, k_s = 2.0, 1.5
        raw = 4.0 - (k_v * max(vol_z, 0) + k_s * stability)
        confidence = float(1.0 / (1.0 + np.exp(-raw)))

        return RegimeState(
            confidence=confidence,
            trend_score=trend_score,
            volatility_z=vol_z,
            dispersion=dispersion,
            correlation_stability=stability,
        )
