"""
Tests for the report_cadence + _sectors-injection contract on each strategy.

Pins:
  - Default report_cadence on BaseStrategy is 'per_cycle' (subclasses without an
    override stay safe).
  - factor_rank, topology, sector_momentum honour BAR_FREQUENCY:
      'daily'    → 'per_cycle'
      'intraday' → 'hourly'
  - Externally-set `_sectors` (the host-side hydration path from market-data-service's
    /internal/api/universe/sectors endpoint) propagates into StrategyOutput.sectors,
    so downstream notification renderers see real GICS labels instead of 'Unknown'.
  - SectorMomentum emits `degraded_unknown_sectors` on factor_attributions when more
    than 50% of the universe is unknown — the downstream Sanity rule reads it to
    raise SECTOR_DATA_MISSING (critical for this strategy).
"""
from __future__ import annotations

import math
import os
import time

import numpy as np
import pytest

from src.application.base_strategy import BaseStrategy
from src.application.factor_rank_strategy import FactorRankStrategy
from src.application.sector_momentum_strategy import SectorMomentumStrategy
from src.application.topology_strategy import TopologyStrategy
from src.domain.dataclasses import OHLCVBar


# ── Helpers ───────────────────────────────────────────────────────────────────

def _bars_for(tickers: list[str], n_bars: int = 60) -> list[OHLCVBar]:
    """Build a per-cycle bar batch (the last close per ticker) — one OHLCVBar per ticker."""
    base_ts = int(time.time() * 1000)
    return [
        OHLCVBar(
            ticker=t, timestamp=base_ts, open=100.0, high=101.0, low=99.0,
            close=100.0 + (i % 5), volume=1_000_000,
        )
        for i, t in enumerate(tickers)
    ]


def _history_factory(tickers: list[str], n_bars: int = 60, seed: int = 42):
    """Per-ticker close-price history; deterministic but varied so strategies emit non-zero z-scores."""
    rng = np.random.default_rng(seed)
    histories = {t: list(100 + np.cumsum(rng.normal(0, 0.5, n_bars))) for t in tickers}

    def lookup(t: str) -> list[float]:
        return histories.get(t, [])

    return lookup


# ── BaseStrategy default ─────────────────────────────────────────────────────

def test_base_strategy_default_report_cadence_is_per_cycle():
    """Subclasses without an override must not accidentally inherit a noisy cadence."""

    class _Dummy(BaseStrategy):
        def update(self, bars, history):
            return None

        @property
        def strategy_id(self) -> str:
            return 'dummy'

        @property
        def min_universe_size(self) -> int:
            return 1

    assert _Dummy().report_cadence == 'per_cycle'


# ── factor_rank report_cadence reads BAR_FREQUENCY ──────────────────────────

def test_factor_rank_per_cycle_when_daily(monkeypatch):
    monkeypatch.setenv('BAR_FREQUENCY', 'daily')
    assert FactorRankStrategy().report_cadence == 'per_cycle'


def test_factor_rank_hourly_when_intraday(monkeypatch):
    monkeypatch.setenv('BAR_FREQUENCY', 'intraday')
    assert FactorRankStrategy().report_cadence == 'hourly'


def test_factor_rank_defaults_to_per_cycle_when_env_missing(monkeypatch):
    monkeypatch.delenv('BAR_FREQUENCY', raising=False)
    assert FactorRankStrategy().report_cadence == 'per_cycle'


# ── topology + sector_momentum honour the same env ─────────────────────────

def test_topology_cadence_switches_on_bar_frequency(monkeypatch):
    monkeypatch.setenv('BAR_FREQUENCY', 'daily')
    assert TopologyStrategy().report_cadence == 'per_cycle'
    monkeypatch.setenv('BAR_FREQUENCY', 'intraday')
    assert TopologyStrategy().report_cadence == 'hourly'


def test_sector_momentum_cadence_switches_on_bar_frequency(monkeypatch):
    monkeypatch.setenv('BAR_FREQUENCY', 'daily')
    assert SectorMomentumStrategy().report_cadence == 'per_cycle'
    monkeypatch.setenv('BAR_FREQUENCY', 'intraday')
    assert SectorMomentumStrategy().report_cadence == 'hourly'


# ── _sectors injection round-trips into StrategyOutput.sectors ─────────────

def test_factor_rank_sectors_injection_round_trips_to_output(monkeypatch):
    monkeypatch.setenv('ROLLING_WINDOW_BARS', '20')
    strat = FactorRankStrategy()
    tickers = [f'T{i}_US_EQ' for i in range(8)]
    # Host-side hydration (matches main.py: `_strategy._sectors.update(sectors)`)
    injected = {
        'T0_US_EQ': 'Technology',
        'T1_US_EQ': 'Technology',
        'T2_US_EQ': 'Health Care',
        'T3_US_EQ': 'Financials',
        'T4_US_EQ': 'Communication',
        'T5_US_EQ': 'Energy',
        'T6_US_EQ': 'Industrials',
        'T7_US_EQ': 'Consumer Discretionary',
    }
    strat._sectors.update(injected)

    out = strat.update(_bars_for(tickers), _history_factory(tickers))
    assert out is not None
    # Every injected sector survives into the StrategyOutput.
    for ticker, expected_sector in injected.items():
        assert out.sectors[ticker] == expected_sector
    # And report_cadence is on the output (no AttributeError).
    assert out.report_cadence in ('per_cycle', 'hourly', 'four_hourly', 'eod')


def test_sector_momentum_emits_degraded_flag_when_unknown_majority():
    strat = SectorMomentumStrategy()
    tickers = [f'T{i}_US_EQ' for i in range(8)]
    # Only 2/8 = 25% known → 75% Unknown → degraded flag > 0.
    strat._sectors.update({'T0_US_EQ': 'Technology', 'T1_US_EQ': 'Health Care'})

    out = strat.update(_bars_for(tickers), _history_factory(tickers))
    assert out is not None
    flags = [attr['degraded_unknown_sectors'] for attr in out.factor_attributions.values()]
    assert all(f > 0.5 for f in flags), (
        f"expected degraded_unknown_sectors > 0.5 on every ticker (universe was 75% Unknown); got {flags}"
    )


def test_sector_momentum_no_degraded_flag_when_sectors_healthy():
    strat = SectorMomentumStrategy()
    tickers = [f'T{i}_US_EQ' for i in range(8)]
    # Every ticker has a known sector → no degradation.
    strat._sectors.update({t: ('Tech' if i % 2 == 0 else 'Fin') for i, t in enumerate(tickers)})

    out = strat.update(_bars_for(tickers), _history_factory(tickers))
    assert out is not None
    flags = [attr['degraded_unknown_sectors'] for attr in out.factor_attributions.values()]
    assert all(f == 0.0 for f in flags), (
        f"expected zero degradation flag with healthy sectors; got {flags}"
    )
