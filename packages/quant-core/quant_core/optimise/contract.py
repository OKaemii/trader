"""Optimiser abstraction — turns a StrategyOutput into long-only target weights.

Replay depends on this Protocol; the concrete `LongOnlyOptimiser` (a Python port of
signal-service's `solveLongOnly`, parity-tested) is injected at the composition root. Keeping
this an interface lets the backtest swap optimiser implementations without touching the driver.
"""
from __future__ import annotations

from typing import Protocol

from ..types import StrategyOutput


class Optimiser(Protocol):
    def weights(
        self, output: StrategyOutput, current_weights: dict[str, float]
    ) -> dict[str, float]:
        """Long-only target weights per ticker. Honours `output.top_k` (truncate to top-K by
        composite score), sector caps, score-proportional sizing, and a turnover guard that
        blends toward `current_weights`. Pure: no I/O.
        """
        ...
