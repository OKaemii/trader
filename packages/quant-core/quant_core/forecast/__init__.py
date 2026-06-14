"""Analyst-free forecast engine — pure, replay-safe earnings-forecast members + their evaluation.

The single source of truth for the mechanical estimates the platform serves in place of vendor
analyst consensus (plan ``analyst-free-estimates-engine.md``). Each module is a pure, fail-closed
function set (the ``screen/quality.py`` style) shared by the live read-API and backtest replay.

Exports are additive per module — keep new lines self-contained so parallel cards merge trivially.
"""
from __future__ import annotations

from .baseline import (
    HORIZONS,
    seasonal_random_walk_eps,
    seasonal_random_walk_eps_path,
)

__all__ = [
    "HORIZONS",
    "seasonal_random_walk_eps",
    "seasonal_random_walk_eps_path",
]
