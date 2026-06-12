"""Parity tests for `quant_core.ticker_identity` — the Python twin of the TS adapter.

These mirror `packages/ticker-identity/src/__tests__/adapter.test.ts` fixture-for-fixture: the same
inputs must produce the same outputs in both languages so the broker representation, the currency
map, and the FB→META rename cannot drift between the TS and Python sides. The final block pins the
`market_of` shim's byte-identical `'US'/'UK'/'OTHER'` values (the contract's legacy jurisdiction
vocabulary) now that it routes through the adapter.
"""

import pytest

from quant_core.fundamentals.contract import MARKET_OTHER, MARKET_UK, MARKET_US, market_of
from quant_core.ticker_identity import TickerIdentity, Trading212TickerAdapter

adapter = Trading212TickerAdapter()


# ── to_t212 ────────────────────────────────────────────────────────────────────
class TestToT212:
    def test_encodes_us_listing_as_symbol_us_eq(self):
        assert adapter.to_t212(TickerIdentity("GOOGL", "US")) == "GOOGL_US_EQ"
        assert adapter.to_t212(TickerIdentity("AAPL", "US")) == "AAPL_US_EQ"

    def test_encodes_lse_listing_as_symbol_l_eq(self):
        # lowercase l joined to the symbol
        assert adapter.to_t212(TickerIdentity("SHEL", "LSE")) == "SHELl_EQ"
        assert adapter.to_t212(TickerIdentity("BP", "LSE")) == "BPl_EQ"

    def test_rejects_empty_symbol_rather_than_emitting_suffix_only(self):
        with pytest.raises(ValueError):
            adapter.to_t212(TickerIdentity("", "US"))
        with pytest.raises(ValueError):
            adapter.to_t212(TickerIdentity("   ", "LSE"))

    def test_throws_on_out_of_type_market_instead_of_returning_none(self):
        # A `market` hydrated from storage could smuggle an unsupported value; the produce-side
        # must reject it (symmetric with from_t212), never silently emit a malformed string.
        with pytest.raises(ValueError):
            adapter.to_t212(TickerIdentity("X", "OTHER"))  # type: ignore[arg-type]


# ── from_t212 ──────────────────────────────────────────────────────────────────
class TestFromT212:
    def test_parses_us_ticker(self):
        assert adapter.from_t212("GOOGL_US_EQ") == TickerIdentity("GOOGL", "US")

    def test_parses_lse_ticker_stripping_trailing_l(self):
        assert adapter.from_t212("SHELl_EQ") == TickerIdentity("SHEL", "LSE")

    @pytest.mark.parametrize("bad", ["SAP_DE_EQ", "BTC_EQ_CFD", "GOOGL", ""])
    def test_rejects_unsupported_or_other_market_form(self, bad):
        # German listing, crypto, plain symbol, and a CFD-shaped suffix are all non-US/LSE
        # equities — they must throw, not coerce to a third market.
        with pytest.raises(ValueError):
            adapter.from_t212(bad)

    @pytest.mark.parametrize("bad", ["_US_EQ", "l_EQ"])
    def test_rejects_suffix_with_no_symbol(self, bad):
        with pytest.raises(ValueError):
            adapter.from_t212(bad)


# ── round-trip ───────────────────────────────────────────────────────────────
class TestRoundTrip:
    US_SYMBOLS = ["GOOGL", "AAPL", "MSFT", "NVDA", "META"]
    LSE_SYMBOLS = ["SHEL", "BP", "HSBA", "VOD", "AZN"]

    @pytest.mark.parametrize("symbol", US_SYMBOLS)
    def test_round_trips_us_identities(self, symbol):
        ident = TickerIdentity(symbol, "US")
        assert adapter.from_t212(adapter.to_t212(ident)) == ident

    @pytest.mark.parametrize("symbol", LSE_SYMBOLS)
    def test_round_trips_lse_identities(self, symbol):
        ident = TickerIdentity(symbol, "LSE")
        assert adapter.from_t212(adapter.to_t212(ident)) == ident

    @pytest.mark.parametrize("t212", ["GOOGL_US_EQ", "AAPL_US_EQ", "SHELl_EQ", "BPl_EQ"])
    def test_round_trips_broker_string(self, t212):
        # to_t212(from_t212(x)) === x for both markets
        assert adapter.to_t212(adapter.from_t212(t212)) == t212

    def test_keeps_cross_listed_symbol_distinct_across_markets(self):
        # SHEL trades on both NYSE and LSE; the market field disambiguates the two,
        # and neither broker form collides.
        assert adapter.to_t212(TickerIdentity("SHEL", "US")) == "SHEL_US_EQ"
        assert adapter.to_t212(TickerIdentity("SHEL", "LSE")) == "SHELl_EQ"
        assert adapter.from_t212("SHEL_US_EQ") == TickerIdentity("SHEL", "US")
        assert adapter.from_t212("SHELl_EQ") == TickerIdentity("SHEL", "LSE")


# ── currency_of ──────────────────────────────────────────────────────────────
class TestCurrencyOf:
    def test_maps_us_to_usd_and_lse_to_gbp(self):
        assert adapter.currency_of(TickerIdentity("GOOGL", "US")) == "USD"
        assert adapter.currency_of(TickerIdentity("SHEL", "LSE")) == "GBP"


# ── apply_rename ─────────────────────────────────────────────────────────────
class TestApplyRename:
    def test_renames_us_fb_to_meta(self):
        assert adapter.apply_rename(TickerIdentity("FB", "US")) == TickerIdentity("META", "US")

    def test_leaves_non_renamed_symbol_untouched(self):
        ident = TickerIdentity("GOOGL", "US")
        assert adapter.apply_rename(ident) == ident

    def test_is_market_aware_fb_on_lse_is_not_the_us_rebrand(self):
        assert adapter.apply_rename(TickerIdentity("FB", "LSE")) == TickerIdentity("FB", "LSE")

    def test_preserves_market_when_renaming(self):
        assert adapter.apply_rename(TickerIdentity("FB", "US")).market == "US"

    def test_round_trips_renamed_symbol_to_canonical_t212(self):
        renamed = adapter.apply_rename(TickerIdentity("FB", "US"))
        assert adapter.to_t212(renamed) == "META_US_EQ"


# ── market_of shim — byte-identical legacy vocabulary ────────────────────────
# `market_of` now routes through the adapter but MUST keep returning the contract's legacy
# `'US'/'UK'/'OTHER'` labels for every existing caller. These reproduce the existing contract +
# fundamentals-ingestion + strategy-engine test fixtures over the shimmed implementation.
class TestMarketOfShim:
    def test_us_suffix_routes_us(self):
        assert market_of("AAPL_US_EQ") == MARKET_US
        assert market_of("MSFT_US_EQ") == MARKET_US
        assert market_of("BRK.B_US_EQ") == MARKET_US

    def test_lse_suffix_routes_uk(self):
        assert market_of("HSBAl_EQ") == MARKET_UK
        assert market_of("BPl_EQ") == MARKET_UK
        assert market_of("RKTl_EQ") == MARKET_UK
        assert market_of("VODl_EQ") == MARKET_UK

    @pytest.mark.parametrize("other", ["SOMECRYPTO", "", "XYZ", "SAP_DE_EQ", "BTC_EQ_CFD"])
    def test_non_tradable_routes_other(self, other):
        assert market_of(other) == MARKET_OTHER

    def test_shim_values_are_plain_strings(self):
        # Callers compare against the string constants 'US'/'UK'/'OTHER' — the shim returns those
        # exact values, not the adapter's 'LSE' vocabulary.
        assert market_of("HSBAl_EQ") == "UK"
        assert market_of("AAPL_US_EQ") == "US"
        assert market_of("nope") == "OTHER"

    def test_preserves_legacy_raw_suffix_semantics_byte_for_byte(self):
        """The adapter is stricter than the legacy router (it trims + rejects malformed forms), but
        `market_of` MUST stay byte-identical to the original `.endswith` classifier for every input
        a caller could send — including degenerate ones the adapter alone would judge differently.
        This is the regression guard for the shim's "legacy wins on disagreement" rule."""

        def legacy(ticker: str) -> str:
            if ticker.endswith("_US_EQ"):
                return "US"
            if ticker.endswith("l_EQ"):
                return "UK"
            return "OTHER"

        # Suffix-only (adapter rejects empty symbol; legacy classifies by suffix) + whitespace-
        # padded (adapter trims-then-accepts; legacy sees no suffix) + ordinary forms.
        for ticker in [
            "_US_EQ", "l_EQ", "  AAPL_US_EQ  ", "\tBPl_EQ", "a_US_EQ", "Xl_EQ",
            "AAPL_US_EQ", "HSBAl_EQ", "SOMECRYPTO", "", "SAP_DE_EQ", "BTC_EQ_CFD",
        ]:
            assert market_of(ticker) == legacy(ticker), ticker
