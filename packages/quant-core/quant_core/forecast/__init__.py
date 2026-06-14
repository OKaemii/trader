"""Analyst-free forecast engine — pure, replay-safe earnings-forecast members + their evaluation.

The single source of truth for the mechanical estimates the platform serves in place of vendor
analyst consensus (plan ``analyst-free-estimates-engine.md``): the seasonal random-walk floor, the
region-bucket seam, the per-firm-year regression inputs, and (in later cards) the Li-Mohanram RI/EP +
HVZ pooled regressions, the ensemble + shrinkage, market-implied growth, the composite
rating-replacement rank, and the dispersion legs. Built bottom-up over the ``pit_metric_history``
accessor (``quant_core.fundamentals.lake.contract``); each module is a pure, fail-closed function set
(the ``screen/quality.py`` style) shared byte-for-byte by the live read-API and backtest replay.

Exports are additive per module — keep new lines self-contained so parallel cards merge trivially.
"""
from __future__ import annotations

from .baseline import (
    HORIZONS,
    seasonal_random_walk_eps,
    seasonal_random_walk_eps_path,
)
from .features import FirmYearFeatures, build_firm_year_features
from .region import REGIONS, Region, region_of

__all__ = [
    "HORIZONS",
    "seasonal_random_walk_eps",
    "seasonal_random_walk_eps_path",
    "Region",
    "REGIONS",
    "region_of",
    "FirmYearFeatures",
    "build_firm_year_features",
]
