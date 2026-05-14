import json
import numpy as np
from dataclasses import dataclass
from typing import Optional, Protocol


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

    State (returns history + previous correlation matrix) can be persisted to a Redis-like
    store via `attach_store()` so warm-up survives pod restarts. Without a store, the engine
    spends ~21 daily cycles (or ~21 intraday bars) in the warm-up sentinel after every boot.
    """

    WINDOW_TREND = 63   # trading days for trend estimation
    WINDOW_VOL   = 21   # trading days for realised vol
    HISTORY_MIN  = 63   # minimum history required
    STATE_KEY    = "regime:state"

    def __init__(self) -> None:
        self._returns_history: list[np.ndarray] = []  # list of cross-sectional return vectors
        self._prev_corr: np.ndarray | None = None
        self._store: Optional["AsyncStore"] = None

    def attach_store(self, store: "AsyncStore") -> None:
        """Attach an async key-value store (typically a redis client) for state persistence."""
        self._store = store

    async def load_from_store(self) -> None:
        """Best-effort restore from the attached store. Safe to call before any update()."""
        if self._store is None:
            return
        raw = await self._store.get(self.STATE_KEY)
        if not raw:
            return
        try:
            blob = json.loads(raw if isinstance(raw, str) else raw.decode("utf-8"))
            self._returns_history = [np.asarray(row, dtype=float) for row in blob.get("returns_history", [])]
            prev = blob.get("prev_corr")
            self._prev_corr = np.asarray(prev, dtype=float) if prev is not None else None
            print(f"[RegimeEngine] restored {len(self._returns_history)} cycles of warm-up state")
        except (ValueError, KeyError, TypeError) as exc:
            print(f"[RegimeEngine] state restore failed (ignoring): {exc}")

    async def _persist(self) -> None:
        if self._store is None:
            return
        # Only persist after warm-up to keep the payload bounded; pre-warmup state would be
        # rebuilt in 21 cycles either way.
        if len(self._returns_history) < self.WINDOW_VOL:
            return
        try:
            blob = {
                "returns_history": [r.tolist() for r in self._returns_history],
                "prev_corr": self._prev_corr.tolist() if self._prev_corr is not None else None,
            }
            await self._store.set(self.STATE_KEY, json.dumps(blob))
        except Exception as exc:  # noqa: BLE001 — logging only; persistence is best-effort
            print(f"[RegimeEngine] state persist failed (ignoring): {exc}")

    async def update_async(self, cross_sectional_returns: np.ndarray) -> RegimeState:
        """Async variant of update() that also persists state to the attached store."""
        state = self.update(cross_sectional_returns)
        await self._persist()
        return state

    def update(self, cross_sectional_returns: np.ndarray) -> RegimeState:
        """
        cross_sectional_returns: shape (n_assets,) for the current period.
        Returns RegimeState with confidence score and component metrics.
        """
        self._returns_history.append(cross_sectional_returns)
        if len(self._returns_history) > self.HISTORY_MIN * 2:
            self._returns_history.pop(0)

        if len(self._returns_history) < self.WINDOW_VOL:
            return RegimeState(confidence=0.5, trend_score=0.0, volatility_z=0.0,
                               dispersion=0.0, correlation_stability=0.0)

        history = np.array(self._returns_history)     # (T, n_assets)
        market_returns = history.mean(axis=1)          # equal-weight index return

        # Trend: rolling 63-day cumulative index return
        trend_window = min(self.WINDOW_TREND, len(market_returns))
        trend_score = float(market_returns[-trend_window:].sum())

        # Volatility z-score: recent 21-day vol relative to full history
        vol_recent = float(market_returns[-self.WINDOW_VOL:].std())
        vol_history = float(market_returns.std()) if len(market_returns) > 30 else vol_recent
        vol_z = (vol_recent - vol_history) / (vol_history + 1e-8)

        # Dispersion: cross-sectional std of returns today
        dispersion = float(cross_sectional_returns.std())

        # Correlation stability: Frobenius distance of current vs previous corr matrix
        recent_mat = history[-self.WINDOW_VOL:].T     # (n_assets, window)
        corr = np.corrcoef(recent_mat)
        stability = 0.0
        if self._prev_corr is not None and self._prev_corr.shape == corr.shape:
            stability = float(np.linalg.norm(corr - self._prev_corr, 'fro'))
        self._prev_corr = corr.copy()

        # Soft confidence: logistic centred on (vol_z=0, stability=0) → 1.0 in calm markets,
        # decaying toward 0 as vol excess and correlation instability grow. Previous formula
        # `raw = -(k_v * max(vol_z, 0) + k_s * stability)` capped at 0.5 because raw was
        # always ≤ 0; that contradicted the docstring (1 = stable). Anchor offset 4.0 puts
        # the calm-market sigmoid output near 0.98.
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


class AsyncStore(Protocol):
    """Minimal interface for the optional persistence store (matches redis.asyncio)."""
    async def get(self, key: str) -> object: ...
    async def set(self, key: str, value: str) -> object: ...
