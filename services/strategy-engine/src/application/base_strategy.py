from abc import ABC, abstractmethod
from typing import Optional
from ..domain.dataclasses import OHLCVBar, StrategyOutput


class BaseStrategy(ABC):
    """
    All strategies implement this contract.
    The signal service consumes StrategyOutput — it never imports a concrete strategy.
    """

    @abstractmethod
    def update(self, bars: list[OHLCVBar]) -> Optional[StrategyOutput]:
        """
        Called on each market data tick. Returns StrategyOutput if ready to emit signals,
        None if insufficient data (e.g. warming up the rolling window).
        Must be pure with respect to external I/O — side effects handled by the engine host.
        """
        ...

    @property
    @abstractmethod
    def strategy_id(self) -> str: ...

    @property
    @abstractmethod
    def min_universe_size(self) -> int: ...
