"""Contract tests for `quant_core.fundamentals` — the canonical line-item key set + market router.

This module is the single shared vocabulary between the fundamentals-ingestion write-path (which
emits these snake_case keys) and the factor/QMJ read-path (which consumes them). These tests pin
two things so the writer and the readers cannot drift:
  - `LINE_ITEMS` is exactly the agreed set and SUPERSETS every key the live consumers read off
    `HistoryView.fundamentals[t]` (QualityFactor, ValueFactor, the QMJ screen, PIT market cap);
  - `market_of()` routes a T212 ticker to its jurisdiction by suffix (the PIT source selector).
"""
from quant_core.fundamentals import (
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

# The exact canonical set Design §6 specifies — frozen here so a change to the contract is a
# deliberate, reviewed edit to BOTH this set and the producing/consuming code, never an accident.
EXPECTED_LINE_ITEMS = {
    "net_income",
    "total_equity",
    "total_assets",
    "total_liabilities",
    "current_assets",
    "current_liabilities",
    "total_debt",
    "gross_profit",
    "total_revenue",
    "cash_flow_ops",
    "market_cap_gbp",
    "shares_outstanding",
    "dividend_yield",
    "earnings_stability",
}


def test_line_items_is_the_canonical_set():
    """LINE_ITEMS matches the agreed snake_case vocabulary exactly (no missing/extra keys)."""
    assert set(LINE_ITEMS) == EXPECTED_LINE_ITEMS


def test_line_items_is_a_tuple_with_no_duplicates():
    """An immutable, duplicate-free contract — order is stable and membership is unambiguous."""
    assert isinstance(LINE_ITEMS, tuple)
    assert len(LINE_ITEMS) == len(set(LINE_ITEMS))


def test_line_items_covers_quality_factor_keys():
    """Every line item QualityFactor reads must be spellable from the contract (factors.py)."""
    quality_keys = {
        "net_income", "total_equity", "gross_profit", "total_revenue",
        "total_debt", "earnings_stability",
    }
    assert quality_keys <= set(LINE_ITEMS)


def test_line_items_covers_value_factor_keys():
    """Every line item ValueFactor reads must be spellable from the contract (factors.py)."""
    value_keys = {"dividend_yield", "net_income", "total_equity", "market_cap_gbp"}
    assert value_keys <= set(LINE_ITEMS)


def test_line_items_covers_qmj_screen_keys():
    """The QMJ screen (screen/quality.py) additionally needs the current-ratio / leverage inputs.
    These were dropped by the old Yahoo projection; the PIT contract MUST carry them."""
    qmj_keys = {
        "net_income", "total_equity", "total_debt",
        "current_assets", "current_liabilities",
    }
    assert qmj_keys <= set(LINE_ITEMS)


def test_line_items_carries_pit_market_cap_inputs():
    """PIT market cap is computed price×shares×FX, so `shares_outstanding` is a contract key, and
    `market_cap_gbp` is the resulting line item both factors read."""
    assert "shares_outstanding" in LINE_ITEMS
    assert "market_cap_gbp" in LINE_ITEMS


def test_market_routing_by_suffix():
    """The PIT source is selected by the T212 ticker suffix."""
    assert market_of("AAPL_US_EQ") == MARKET_US
    assert market_of("MSFT_US_EQ") == MARKET_US
    assert market_of("HSBAl_EQ") == MARKET_UK
    assert market_of("BPl_EQ") == MARKET_UK
    assert market_of("SOMECRYPTO") == MARKET_OTHER
    assert market_of("") == MARKET_OTHER


def test_market_routing_us_suffix_takes_priority_over_generic():
    """A US suffix must not be mistaken for anything else; the suffix match is exact."""
    # `_US_EQ` ends in neither `l_EQ` (UK) nor a bare symbol — it routes US.
    assert market_of("BRK.B_US_EQ") == MARKET_US
    # A name ending in `l_EQ` is UK even if it contains other tokens.
    assert market_of("RKTl_EQ") == MARKET_UK


def test_market_constants_are_distinct():
    """US / UK / OTHER are three distinct route labels."""
    assert len({MARKET_US, MARKET_UK, MARKET_OTHER}) == 3


def test_source_stamps_are_the_three_documented_origins():
    """The source stamps persisted in factor_scores name exactly the three documented origins."""
    assert SOURCE_YAHOO_SNAPSHOT == "yahoo-snapshot"
    assert SOURCE_PIT_EDGAR == "pit-edgar"
    assert SOURCE_PIT_COMPANIES_HOUSE == "pit-companies-house"
    assert len({SOURCE_YAHOO_SNAPSHOT, SOURCE_PIT_EDGAR, SOURCE_PIT_COMPANIES_HOUSE}) == 3


def test_fundamentals_as_of_protocol_is_runtime_checkable():
    """The relocated Protocol is runtime_checkable so a duck-typed provider can be isinstance-d.

    A class with the three async/sync members structurally satisfies it; one missing `source_for`
    does not (runtime_checkable only checks member presence, which is enough to catch a stub that
    forgot the stamp method)."""

    class _GoodProvider:
        async def fetch_many(self, tickers, as_of_ms):
            return {}

        async def fetch(self, ticker, as_of_ms):
            return {}

        def source_for(self, ticker):
            return SOURCE_PIT_EDGAR

    class _MissingSourceFor:
        async def fetch_many(self, tickers, as_of_ms):
            return {}

        async def fetch(self, ticker, as_of_ms):
            return {}

    assert isinstance(_GoodProvider(), FundamentalsAsOf)
    assert not isinstance(_MissingSourceFor(), FundamentalsAsOf)
