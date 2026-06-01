"""Replay driver determinism — two runs over identical inputs produce identical weights.

Uses in-memory fakes for every Protocol dependency (no DB/HTTP), so this validates the
driver's orchestration + the strategy/optimiser determinism without infrastructure.
"""
import numpy as np
import pytest

from quant_core.features.null_store import NullFeatureStore
from quant_core.optimise.long_only import LongOnlyOptimiser
from quant_core.portfolio.providers import EmptyPortfolioProvider
from quant_core.replay.driver import Replay
from quant_core.strategy.contract import HistoryView
from quant_core.strategy.factory import make_strategy


class _FakeBars:
    """Deterministic, as-of-independent history (constant across steps)."""

    def __init__(self, n_tickers=12, n_closes=400):
        # ≥ factor_rank's 300-bar window, all-uptrending (dispersed positive drift) so the
        # TrendFilter retains the universe and the replay produces non-empty steps.
        rng = np.random.default_rng(1234)
        self._closes = {}
        for i in range(n_tickers):
            steps = rng.normal(0.0008 + 0.0004 * i, 0.011, size=n_closes)
            self._closes[f"T{i}"] = [float(x) for x in 100.0 * np.exp(np.cumsum(steps))]

    async def history_as_of(self, tickers, as_of_ms, lookback_bars):
        closes = {t: self._closes[t][-lookback_bars:] for t in tickers if t in self._closes}
        return HistoryView(closes=closes, volumes={}, timestamps={})

    async def daily_bars(self, ticker, start_ms, end_ms=None):
        return []


def _replay():
    return Replay(
        strategy=make_strategy('factor_rank_v1'),
        bars=_FakeBars(),
        store=NullFeatureStore(),
        portfolio=EmptyPortfolioProvider(),
        optimiser=LongOnlyOptimiser(),
    )


def _universe_at(_t):
    return [f"T{i}" for i in range(12)]


@pytest.mark.asyncio
async def test_replay_is_deterministic():
    lo, hi, step = 1_700_000_000_000, 1_700_000_000_000 + 10 * 86_400_000, 86_400_000
    a = await _replay().run(lo, hi, step, _universe_at, write_features=False)
    b = await _replay().run(lo, hi, step, _universe_at, write_features=False)
    assert len(a.steps) == len(b.steps) > 0
    assert a.weights_series == b.weights_series


@pytest.mark.asyncio
async def test_replay_emits_weights_summing_within_one():
    lo, hi, step = 1_700_000_000_000, 1_700_000_000_000 + 3 * 86_400_000, 86_400_000
    res = await _replay().run(lo, hi, step, _universe_at, write_features=False)
    for _ts, weights in res.weights_series:
        assert sum(weights.values()) <= 1 + 1e-9
        assert all(w >= 0 for w in weights.values())
