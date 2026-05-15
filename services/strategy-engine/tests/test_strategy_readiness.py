"""
Tests for the Mongo-backed readiness path.

The whole point of the refactor: strategy-engine should emit signals on the FIRST cycle
post-restart, provided Mongo already has enough history. The old design needed N stream
arrivals to warm up — with 24h poll cadence that was 20 days of wall time even when the
data was sitting in Mongo waiting.

These tests don't run the full process_loop — they call strategy.update() directly with
a synthetic history lookup. Combined with the market_data_client tests (which prove the
HTTP path correctly populates that lookup), they cover the contract end-to-end.
"""
from __future__ import annotations

import numpy as np
import pytest

from src.application.factor_rank_strategy import FactorRankStrategy
from src.application.sector_momentum_strategy import SectorMomentumStrategy
from src.application.topology_strategy import TopologyStrategy
from src.domain.dataclasses import OHLCVBar


def _bar(ticker: str, ts: int = 0, close: float = 100.0) -> OHLCVBar:
    return OHLCVBar(ticker=ticker, timestamp=ts, open=close, high=close, low=close, close=close, volume=100)


def _synth_history(n: int, base: float = 100.0, drift: float = 0.001, seed: int = 42) -> list[float]:
    """Geometric brownian-ish series so log-returns are well-defined and z-scores non-trivial."""
    rng = np.random.default_rng(seed)
    rets = rng.normal(drift, 0.01, n)
    series = base * np.exp(np.cumsum(rets))
    return series.tolist()


class TestFactorRankReadiness:
    def test_emits_signal_on_first_cycle_when_history_is_sufficient(self):
        """First cycle, no prior arrivals, but Mongo has 25 daily bars per ticker.
        Strategy should emit a StrategyOutput — that's the bug the refactor fixes."""
        strategy = FactorRankStrategy()
        tickers = [f"T{i}_US_EQ" for i in range(6)]   # > min_universe_size (5)
        # Each ticker has 25 daily closes — comfortably above the 20-bar window.
        history_map = {t: _synth_history(25, base=100 + i, seed=i) for i, t in enumerate(tickers)}
        bars = [_bar(t) for t in tickers]

        output = strategy.update(bars, lambda t: history_map.get(t, []))
        assert output is not None, "strategy should emit on first cycle when Mongo has history"
        assert output.strategy_id == "factor_rank_v1"
        assert set(output.composite_scores.keys()) == set(tickers)

    def test_returns_none_when_fewer_than_min_universe_tickers_are_ready(self):
        """Edge: 3 tickers have history, 2 don't — total ready < min_universe_size."""
        strategy = FactorRankStrategy()
        tickers_with_history = ["T0_US_EQ", "T1_US_EQ", "T2_US_EQ"]
        tickers_without      = ["T3_US_EQ", "T4_US_EQ"]
        history_map = {t: _synth_history(25, seed=i) for i, t in enumerate(tickers_with_history)}
        bars = [_bar(t) for t in tickers_with_history + tickers_without]

        output = strategy.update(bars, lambda t: history_map.get(t, []))
        # min_universe_size is 5; only 3 are ready → None.
        assert output is None

    def test_per_ticker_independent_readiness(self):
        """Regression for the deploy-time pattern of "stale filter killed all bars".
        Tickers that have full history must be scored even if siblings have empty history."""
        strategy = FactorRankStrategy()
        ready = [f"R{i}_US_EQ" for i in range(6)]
        empty = [f"E{i}_US_EQ" for i in range(3)]
        history_map = {t: _synth_history(25, seed=i) for i, t in enumerate(ready)}
        bars = [_bar(t) for t in ready + empty]

        output = strategy.update(bars, lambda t: history_map.get(t, []))
        assert output is not None
        # Only the ready tickers should appear in the universe.
        assert set(output.ticker_universe) == set(ready)

    def test_returns_none_when_no_bars_active(self):
        """Empty stream batch → no active tickers → no signal regardless of Mongo."""
        strategy = FactorRankStrategy()
        history_map = {f"T{i}_US_EQ": _synth_history(25, seed=i) for i in range(10)}
        output = strategy.update([], lambda t: history_map.get(t, []))
        assert output is None


class TestSectorMomentumReadiness:
    def test_emits_on_first_cycle_with_sufficient_history(self):
        strategy = SectorMomentumStrategy()
        # Seed sector metadata since this strategy looks it up by ticker.
        strategy._sectors = {f"T{i}_US_EQ": "Tech" if i < 3 else "Health" for i in range(6)}
        tickers = list(strategy._sectors.keys())
        history_map = {t: _synth_history(25, seed=i) for i, t in enumerate(tickers)}

        output = strategy.update([_bar(t) for t in tickers], lambda t: history_map.get(t, []))
        assert output is not None
        assert output.strategy_id == "sector_momentum_v1"


class TestTopologyReadiness:
    def test_requires_extra_history_compared_to_factor_rank(self):
        """Topology declares rolling_window=30, not 20. 25-bar history isn't enough."""
        strategy = TopologyStrategy()
        tickers = [f"T{i}_US_EQ" for i in range(12)]  # > min_universe_size (10)
        history_map = {t: _synth_history(25, seed=i) for i, t in enumerate(tickers)}

        output = strategy.update([_bar(t) for t in tickers], lambda t: history_map.get(t, []))
        # 25 < 30 → not ready, even though count meets the universe minimum.
        assert output is None

    def test_emits_when_30_bars_per_ticker_available(self):
        strategy = TopologyStrategy()
        tickers = [f"T{i}_US_EQ" for i in range(12)]
        history_map = {t: _synth_history(35, seed=i) for i, t in enumerate(tickers)}

        output = strategy.update([_bar(t) for t in tickers], lambda t: history_map.get(t, []))
        assert output is not None
        assert output.strategy_id == "topology_v1"
        # Topology-specific fields should be populated.
        assert output.betti_curves is not None
        assert output.laplacian_residuals is not None
