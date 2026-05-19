from abc import ABC, abstractmethod
from typing import Callable, Optional
from ..domain.dataclasses import OHLCVBar, StrategyOutput


# Pre-populated lookup the engine host hands to each strategy at update time. The
# host fetches history once per cycle (one HTTP round-trip to market-data-service)
# and gives strategies a sync accessor — keeps update() pure.
PriceHistoryLookup = Callable[[str], list[float]]


class BaseStrategy(ABC):
    """
    All strategies implement this contract.

    Each cycle the engine host calls update(bars, history) where:
      - bars     = the tickers active this cycle (trigger / universe filter)
      - history  = a per-ticker close-price lookup, already populated from Mongo via
                   market-data-service for the rolling-window range the strategy needs.
                   Returns [] for tickers without enough history yet — strategies treat
                   that as "skip" inside their own min-length check.

    Strategies must be pure with respect to external I/O — the host owns Mongo/HTTP.
    """

    @abstractmethod
    def update(
        self,
        bars: list[OHLCVBar],
        history: PriceHistoryLookup,
    ) -> Optional[StrategyOutput]:
        """Return StrategyOutput if ready to emit signals, None otherwise."""
        ...

    @property
    @abstractmethod
    def strategy_id(self) -> str: ...

    @property
    @abstractmethod
    def min_universe_size(self) -> int: ...

    @property
    def rolling_window(self) -> int:
        """How many historical bars the strategy needs per ticker."""
        return 20

    @property
    def prewarm_cycles(self) -> int:
        """
        How many *historical* cycles of update() the engine host should replay at boot
        to populate any cross-cycle state (regime returns history, feature stability
        accumulators, etc.) BEFORE subscribing to the live stream.

        Default 0 = no prewarm (strategies without cross-cycle state). Strategies that
        carry state across cycles should return the depth at which their internal
        buffers saturate — e.g. RegimeEngine.HISTORY_MIN * 2 = 126 for factor_rank.

        See main.historical_prewarm() for the replay implementation.
        """
        return 0

    @property
    def report_cadence(self) -> str:
        """
        How often the notification-service should produce an enriched analysis email
        for this strategy. One of:
            'per_cycle'    — one email per StrategyOutput emit (daily rebalances).
            'hourly'       — bucketed across cycles, flushed top-of-hour.
            'four_hourly'  — bucketed, flushed every 4h.
            'eod'          — bucketed, flushed at the relevant exchange's session close.

        Daily strategies should stay at 'per_cycle'. Intraday strategies should return
        'hourly' so the 5m-cycle firehose collapses into one digest per hour. The
        operator can override down (e.g. `four_hourly`) via REPORT_INTRADAY_CADENCE
        but cannot override an intraday strategy back to `per_cycle` — that would
        reintroduce the 12-emails-per-hour problem the cadence was designed to fix.
        """
        return 'per_cycle'
