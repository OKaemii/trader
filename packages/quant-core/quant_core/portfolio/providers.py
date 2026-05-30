"""Concrete PortfolioProvider implementations.

The current strategies' decide() does not read portfolio state (sizing happens downstream in
signal-service / the optimiser's turnover guard, which the Replay driver feeds from its own
running weights). So an empty provider is correct today. Phase 2 adds a
FillsReconstructedPortfolioProvider that rebuilds state as-of a replay instant from the
fills_history ledger; the Protocol is already in place for that swap.
"""
from __future__ import annotations

from ..strategy.contract import PortfolioState

_EMPTY = PortfolioState(current_weights={}, nav=0.0, cash=0.0)


class EmptyPortfolioProvider:
    """Always-empty portfolio (startup-capital scenario / strategies that ignore portfolio)."""

    async def at(self, as_of_ms: int) -> PortfolioState:
        return _EMPTY
