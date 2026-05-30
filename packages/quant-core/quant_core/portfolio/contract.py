"""PortfolioProvider abstraction — supplies portfolio state to `decide`.

Live: a snapshot of current weights/NAV/cash (HTTP to portfolio-service). Replay: the
portfolio reconstructed as-of a replay timestamp (empty before the system's first trade).
The driver depends only on this Protocol.
"""
from __future__ import annotations

from typing import Protocol

from ..strategy.contract import PortfolioState


class PortfolioProvider(Protocol):
    async def at(self, as_of_ms: int) -> PortfolioState:
        """Portfolio state as-of the given instant. `as_of_ms == now` for live."""
        ...
