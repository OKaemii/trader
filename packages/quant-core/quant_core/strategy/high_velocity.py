"""HighVelocityStrategy (high_velocity_v1) — concentrated monthly momentum + quality.

Pipeline, gated to the first trading session of each calendar month (else it holds):
  1. screen the universe by market cap >= min_cap_gbp AND the fail-closed QMJ quality gate
     (fundamentals attached to HistoryView by the host);
  2. rank survivors by 12-1 momentum, take the top `top_n_momentum` (default 30);
  3. drop the `drop_n_vol` (default 10) highest-volatility names → the held set (default 20);
  4. emit weighting='inverse_vol' + per-ticker volatility so the optimiser sizes w_i ∝ 1/σ_i.

Pure (no I/O); satisfies the Strategy Protocol structurally — no inheritance. Composes a
RebalanceClock + the shared 12-1 momentum / annualised-vol / QMJ utilities. No RegimeEngine:
a monthly inverse-vol basket leaves risk management to the inverse-vol tilt + signal-service's
vol-targeting + circuit breaker, so regime_confidence/position_size_multiplier are neutral (1.0).
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..types import StrategyOutput
from .contract import FeatureVector, HistoryView, PortfolioState, StrategyConfig, StrategyParams
from .collaborators.rebalance_clock import RebalanceClock
from .collaborators.volatility import annualised_vol, TRADING_DAYS
from .collaborators.covariance import shrunk_covariance
from ..screen.quality import quality_pass


def momentum_12_1(history: HistoryView, tickers: list[str], lookback: int, skip: int) -> dict[str, float]:
    """Raw 12-1 momentum = log return over the `lookback` window ending `skip` bars ago. Positive
    for uptrends (so it doubles as a usable confidence score). Names with too little history are
    omitted. Matches MomentumFactor's pre-z-score value (sum of daily log-returns over the slice).
    """
    out: dict[str, float] = {}
    need = max(1, lookback) + max(0, skip) + 1
    for t in tickers:
        closes = history.closes.get(t, [])
        if len(closes) < need:
            continue
        arr = np.asarray(closes, dtype=float)
        end = len(arr) - max(0, skip)
        start = max(0, end - max(1, lookback))
        p0, p1 = arr[start], arr[end - 1]
        if p0 > 0 and p1 > 0:
            out[t] = float(math.log(p1 / p0))
    return out


class HighVelocityStrategy:
    def __init__(
        self,
        clock: RebalanceClock,
        config: StrategyConfig,
        *,
        top_n_momentum: int = 30,
        drop_n_vol: int = 10,
        vol_lookback: int = 90,
        mom_lookback: int = 252,
        mom_skip: int = 21,
        min_cap_gbp: float = 5_000_000_000.0,
    ) -> None:
        self._clock = clock
        self.config = config
        self._top_n = max(1, top_n_momentum)
        self._drop_n = max(0, drop_n_vol)
        self._vol_lookback = vol_lookback
        self._mom_lookback = mom_lookback
        self._mom_skip = mom_skip
        self._min_cap = min_cap_gbp
        self._sectors: dict[str, str] = {}

    def parameter_space(self) -> dict[str, list[float]]:
        # Lean default sweep — the MCPT validator widens this via the portal grid editor.
        return {"mom_lookback": [126.0, 252.0], "vol_lookback": [60.0, 90.0]}

    def parameter_defaults(self) -> dict[str, float]:
        return {
            "mom_lookback": float(self._mom_lookback),
            "mom_skip": float(self._mom_skip),
            "vol_lookback": float(self._vol_lookback),
        }

    def compute_features(self, history: HistoryView, as_of_ms: int, params: StrategyParams) -> Optional[FeatureVector]:
        # Monthly gate — emit only on the first session of a new calendar month; else hold.
        if not self._clock.is_rebalance(history.timestamps):
            return None
        for t in history.closes:
            self._sectors.setdefault(t, "Unknown")

        f = history.fundamentals
        # 1) market cap >= floor AND fail-closed QMJ quality
        eligible = [
            t for t in history.closes
            if f.get(t, {}).get("market_cap_gbp", 0.0) >= self._min_cap and quality_pass(f.get(t, {}))
        ]
        if len(eligible) < self.config.min_universe_size:
            return None

        # 2) 12-1 momentum rank → top N
        mom = momentum_12_1(
            history, eligible,
            int(params.get("mom_lookback", self._mom_lookback)),
            int(params.get("mom_skip", self._mom_skip)),
        )
        if len(mom) < self.config.min_universe_size:
            return None
        top = sorted(mom.keys(), key=lambda t: mom[t], reverse=True)[: self._top_n]

        # 3) drop the highest-vol names → held set = the (top_n - drop_n) lowest-vol of the top.
        vol = annualised_vol(history, top, int(params.get("vol_lookback", self._vol_lookback)))
        held_k = max(self.config.min_universe_size, self._top_n - self._drop_n)
        survivors = sorted(top, key=lambda t: vol[t])[:held_k]
        if not survivors:
            return None

        composite_scores = {t: max(mom[t], 1e-9) for t in survivors}   # positive ⇒ usable confidence
        per_ticker = {t: {"momentum": mom[t], "volatility": vol[t], "residual_alpha": mom[t]} for t in survivors}

        # 4) covariance over the held set (vol window; min-length guard keeps the matrix rectangular).
        w = min(self._vol_lookback + 1, min(len(history.closes[t]) for t in survivors))
        if len(survivors) >= 2 and w >= 3:
            prices = np.array([history.closes[t][-w:] for t in survivors], dtype=float)
            rets = np.diff(np.log(prices), axis=1)
            cov = shrunk_covariance(rets).tolist()
        else:
            cov = np.diag([
                (vol[t] / math.sqrt(TRADING_DAYS)) ** 2 if math.isfinite(vol[t]) else 1e-4 for t in survivors
            ]).tolist()

        mom_vals = [mom[t] for t in survivors]
        vol_vals = [vol[t] for t in survivors if math.isfinite(vol[t])]
        return FeatureVector(
            strategy_id=self.config.strategy_id,
            observation_ts=as_of_ms,
            ticker_universe=survivors,
            composite_scores=composite_scores,
            per_ticker=per_ticker,
            cross_sectional_stats={
                "momentum_mean": float(np.mean(mom_vals)) if mom_vals else 0.0,
                "vol_mean": float(np.mean(vol_vals)) if vol_vals else 0.0,
                "n_eligible": float(len(eligible)),
                "n_survivors": float(len(survivors)),
            },
            regime_confidence=1.0,
            position_size_multiplier=1.0,
            signal_weights=None,
            sectors={t: self._sectors.get(t, "Unknown") for t in survivors},
            covariance_matrix=cov,
            feature_stability=None,
        )

    def decide(self, features: FeatureVector, portfolio: PortfolioState) -> Optional[StrategyOutput]:
        return StrategyOutput(
            timestamp=features.observation_ts,
            strategy_id=features.strategy_id,
            ticker_universe=features.ticker_universe,
            composite_scores=features.composite_scores,
            factor_attributions=features.per_ticker,
            sectors=features.sectors,
            covariance_matrix=features.covariance_matrix,
            regime_confidence=features.regime_confidence,
            position_size_multiplier=features.position_size_multiplier,
            signal_weights=features.signal_weights,
            feature_stability=features.feature_stability,
            report_cadence=self.config.report_cadence,
            top_k=self.config.top_k,
            weighting="inverse_vol",
        )
