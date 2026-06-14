"""Analyst-free mechanical-forecast engine — pure, replay-safe quant-core code.

The single source of truth for the estimates the platform synthesises *mechanically* from the
point-in-time EDGAR lake (no vendor analyst consensus): the seasonal random-walk floor, the
Li-Mohanram RI/EP + HVZ pooled regressions, the ensemble + shrinkage, market-implied growth, the
composite rating-replacement rank, and the dispersion legs. Built bottom-up over the
``pit_metric_history`` accessor (``quant_core.fundamentals.lake.contract``); shared byte-for-byte by
the live read-API (fundamentals-api) and backtest replay so the two never drift.

This package layer (Task 2) lands the two foundations the regression members consume:

  * :mod:`quant_core.forecast.region` — the region-bucket seam (``region_of`` → US today; the
    dev-ex-US / EM buckets are the card-131 forward seam).
  * :mod:`quant_core.forecast.features` — the per-firm-year regression inputs (E, A, B, D, DD, NegE,
    AC), scaled by total assets into the currency-free pool the cross-sectional OLS trains on.

Mirrors the pure, fail-closed ``quant_core.screen.quality`` shape exactly: no I/O, no network, a
missing leg is omitted (never coerced to 0), so quality data we do not have is never a fabricated
forecast input.
"""
from __future__ import annotations

from quant_core.forecast.features import FirmYearFeatures, build_firm_year_features
from quant_core.forecast.region import REGIONS, Region, region_of

__all__ = [
    "Region",
    "REGIONS",
    "region_of",
    "FirmYearFeatures",
    "build_firm_year_features",
]
