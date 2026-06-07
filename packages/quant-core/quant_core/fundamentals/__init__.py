"""quant-core fundamentals contract — canonical line-item keys + the PIT seam.

The shared vocabulary between the fundamentals-ingestion write-path and the factor read-path, plus
the `FundamentalsAsOf` Protocol, source stamps, and market router. Lives in quant-core because it is
read by both live (strategy-engine) and replay (backtest-engine); the concrete Yahoo impl stays in
strategy-engine and re-exports these names. See `contract.py` for the full rationale.
"""
from .contract import (
    LINE_ITEMS,
    MARKET_OTHER,
    MARKET_UK,
    MARKET_US,
    SOURCE_PIT_COMPANIES_HOUSE,
    SOURCE_PIT_EDGAR,
    SOURCE_YAHOO_SNAPSHOT,
    FundamentalsAsOf,
    market_of,
)

__all__ = [
    "LINE_ITEMS",
    "FundamentalsAsOf",
    "market_of",
    "SOURCE_YAHOO_SNAPSHOT",
    "SOURCE_PIT_EDGAR",
    "SOURCE_PIT_COMPANIES_HOUSE",
    "MARKET_US",
    "MARKET_UK",
    "MARKET_OTHER",
]
