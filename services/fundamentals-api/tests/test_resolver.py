"""Lake-backed resolver tests — the PIT read core (epic Task 10).

Proves the byte-compatible seam + the PIT guarantee against a SYNTHETIC lake built in the EXACT on-disk
shape the harvester writes (the Task-3 SCHEMA + ticker_history/entities Parquet), read through the REAL
quant-core lake engine (`store` + `metrics` + `contract`) — no mock of the read path. The engine swapped
from Timescale to the lake; the HTTP contract did NOT, so these tests pin the byte-equivalence the seam
consumers depend on:

  * a covered US name → the canonical snake_case LINE_ITEMS dict (the 12 raw legs + the 2 Gap-2 enriched
    legs), with EXACT key spellings + the provenance triple — byte-for-byte the captured current shape;
  * a PAST as_of returns ONLY facts with knowledge_ts ≤ as_of (no look-ahead — the guard is the lake
    store's SQL); a restatement shows the FIRST PRINT at the original as_of and the RESTATED value later;
  * a non-US name → `{}` fail-closed (no EDGAR, NO Yahoo — Thread C); an unknown/cold name → `{}`;
  * the entity-SIC SECTOR TEMPLATE is threaded (a bank resolves its `RevenuesNetOfInterest…` override
    and fail-closes `gross_profit`/`current_assets` — the Task-6 gotcha this card wires);
  * the Redis read-through short-circuits the lake on a hit, and a cache failure falls through;
  * the request ticker is accepted as legacy T212 OR bare (transition-safe);
  * the Gap-2 market-cap override (price×shares×fx) + dividend-yield leg wire into the resolved payload.

No network, no Timescale, no Mongo.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from src.resolver import FundamentalsResolver, identity_of, t212_of
from tests.fakes import (
    FakeMarketDataReader,
    FakeRedis,
    annual,
    entity_row,
    full_name_facts,
    instant,
    ms,
    ticker_row,
    write_entities,
    write_facts,
    write_ticker_history,
)

from quant_core.fundamentals.contract import LINE_ITEMS, SOURCE_PIT_EDGAR
from quant_core.fundamentals.lake.store import Store

# CIKs for the synthetic names.
CIK_FULL = 100      # fully-covered US software name (general template)
CIK_BANK = 600      # a bank (SIC 6021) — exercises the sector-template threading
CIK_ACME = 999      # restatement + rename (OLDT -> NEWT)

# A clean as-of after every FY2023 fact below is knowable (FY2023 10-K knowable 2024-02-16).
AS_OF = ms(2024, 6, 1)


@pytest.fixture()
def lake(tmp_path: Path) -> Path:
    """A synthetic lake: a fully-covered US name, a bank (sector-override), and a restate+rename name."""
    root = tmp_path / "lake"
    root.mkdir()

    # CIK_FULL — every leg (general template).
    write_facts(root, CIK_FULL, full_name_facts(CIK_FULL))

    # CIK_BANK — a bank's revenue is RevenuesNetOfInterestExpense (the sector override), and it reports
    # NO GrossProfit / AssetsCurrent at all (the registry's empty bank overrides ⇒ those legs fail
    # closed). Seed the bank-shaped tags + net income (3 annuals for earnings_stability) + equity/shares.
    k = ms(2024, 2, 16)
    k22, k21 = ms(2023, 2, 16), ms(2022, 2, 16)
    write_facts(root, CIK_BANK, [
        annual(CIK_BANK, "NetIncomeLoss", 2021, 90.0, k21),
        annual(CIK_BANK, "NetIncomeLoss", 2022, 100.0, k22),
        annual(CIK_BANK, "NetIncomeLoss", 2023, 110.0, k),
        # bank top-line: the sector override's first tag. A manufacturer's default Revenues tag is NOT
        # seeded, so a sector-BLIND read would find no total_revenue at all — the threading is what makes
        # this resolve.
        annual(CIK_BANK, "RevenuesNetOfInterestExpense", 2023, 5000.0, k),
        # a GrossProfit tag IS present in the file — but the bank template's override is empty, so a
        # CORRECTLY-threaded read must NOT surface gross_profit for the bank (fail-closed).
        annual(CIK_BANK, "GrossProfit", 2023, 999.0, k),
        instant(CIK_BANK, "StockholdersEquity", "2023-12-31", 800.0, k),
        instant(CIK_BANK, "EntityCommonStockSharesOutstanding", "2023-12-31", 70.0, k,
                taxonomy="dei", unit="shares"),
    ])

    # CIK_ACME — a first-print FY2023 revenue (400) then a 10-K/A restatement (402) at a later
    # knowledge_ts; renamed OLDT -> NEWT on 2023-06-01 (same CIK throughout).
    first_kts = ms(2024, 2, 16)
    restate_kts = ms(2024, 8, 12)
    write_facts(root, CIK_ACME, [
        annual(CIK_ACME, "NetIncomeLoss", 2023, 110.0, first_kts),
        annual(CIK_ACME, "Revenues", 2023, 400.0, first_kts),
        # the SAME (start,end) period restated to 402 at a later knowledge_ts (the store supersedes on
        # read via row_number() ORDER BY knowledge_ts DESC).
        annual(CIK_ACME, "Revenues", 2023, 402.0, restate_kts),
        instant(CIK_ACME, "StockholdersEquity", "2023-12-31", 500.0, first_kts),
        instant(CIK_ACME, "EntityCommonStockSharesOutstanding", "2023-12-31", 50.0, first_kts,
                taxonomy="dei", unit="shares"),
    ])

    write_ticker_history(root, [
        ticker_row(CIK_FULL, "FULL"),
        ticker_row(CIK_BANK, "BANK"),
        ticker_row(CIK_ACME, "OLDT", valid_from=date(2020, 1, 1), valid_to=date(2023, 6, 1)),
        ticker_row(CIK_ACME, "NEWT", valid_from=date(2023, 6, 1), valid_to=None),
    ])
    write_entities(root, [
        entity_row(CIK_FULL, "FULL"),                                  # SIC 7372 → general
        entity_row(CIK_BANK, "BANK", sic="6021", sic_desc="State commercial banks"),  # → bank
        entity_row(CIK_ACME, "NEWT"),
    ])
    return root


def _resolver(lake: Path, redis=None, market_data=None) -> FundamentalsResolver:
    return FundamentalsResolver(Store(lake), redis=redis, market_data=market_data)


# ── byte-compatible payload: the captured current shape ───────────────────────────────────────────────
@pytest.mark.asyncio
async def test_covered_us_name_payload_byte_equivalent(lake: Path) -> None:
    """A covered US name's `to_payload()` is the EXACT shape the seam consumers parse: the snake_case
    LINE_ITEMS keys spread at the top level + the three provenance keys, no extras. This is the
    byte-equivalence assertion vs the captured current shape (`{<14 snake_case>, source, observation_ts,
    knowledge_ts}`)."""
    out = await _resolver(lake).get_pit_fundamentals(["FULL_US_EQ"], AS_OF)
    payload = out["FULL_US_EQ"].to_payload()

    # The 12 raw legs the lake supplies (market_cap_gbp/dividend_yield need the Gap-2 reader, not wired
    # here) + EXACTLY the three provenance keys — nothing else.
    raw_legs = {
        "net_income", "total_revenue", "gross_profit", "cash_flow_ops",
        "total_equity", "total_assets", "total_liabilities", "current_assets",
        "current_liabilities", "total_debt", "shares_outstanding", "earnings_stability",
    }
    provenance = {"source", "observation_ts", "knowledge_ts"}
    assert set(payload) == raw_legs | provenance
    # every line-item key is a canonical LINE_ITEMS member (spelling pinned by the shared contract).
    assert (set(payload) - provenance) <= set(LINE_ITEMS)
    # values + provenance.
    assert payload["net_income"] == 110.0
    assert payload["total_revenue"] == 1000.0
    assert payload["total_debt"] == 250.0          # LongTermDebt — the select-fallback
    assert payload["source"] == SOURCE_PIT_EDGAR   # "pit-edgar"
    assert payload["observation_ts"] is not None
    assert payload["knowledge_ts"] is not None


@pytest.mark.asyncio
async def test_payload_key_spellings_are_canonical(lake: Path) -> None:
    """Every non-provenance key in the payload is a LINE_ITEMS spelling — the byte-for-byte vocabulary
    the writer (the lake contract pivot) and the readers (strategy-engine/market-data) agree on."""
    out = await _resolver(lake).get_pit_fundamentals(["FULL_US_EQ"], AS_OF)
    li = out["FULL_US_EQ"].line_items
    assert set(li) <= set(LINE_ITEMS)
    assert set(li) == set(LINE_ITEMS) & set(li)  # tautology guard: no key outside the vocabulary


# ── 14 legs with the Gap-2 enrichment ─────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_covered_us_name_full_14_legs_with_enrichment(lake: Path) -> None:
    """With the Gap-2 reader injected, a fully-covered name resolves the 12 raw legs PLUS market_cap_gbp
    + dividend_yield = the full 14-key LINE_ITEMS set."""
    md = FakeMarketDataReader()
    md.set_close("FULL_US_EQ", AS_OF, 30.0)
    md.set_fx("USD", 0.79)
    md.set_dividend_yield("FULL_US_EQ", 0.012)
    out = await _resolver(lake, market_data=md).get_pit_fundamentals(["FULL_US_EQ"], AS_OF)
    li = out["FULL_US_EQ"].line_items
    assert set(li) == set(LINE_ITEMS)  # all 14
    assert li["market_cap_gbp"] == 30.0 * 50.0 * 0.79  # price × shares × fx
    assert li["dividend_yield"] == 0.012


# ── no look-ahead + restatement ───────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_as_of_before_restatement_returns_first_print(lake: Path) -> None:
    """An as-of between the first print and the restatement returns the FIRST-print value (402 is not
    yet knowable — the lake store's knowledge_ts ≤ as_of guard)."""
    between = ms(2024, 5, 1)  # after first print (2024-02-16), before restatement (2024-08-12)
    out = await _resolver(lake).get_pit_fundamentals(["NEWT_US_EQ"], between)
    assert out["NEWT_US_EQ"].line_items["total_revenue"] == 400.0


@pytest.mark.asyncio
async def test_as_of_after_restatement_returns_restated(lake: Path) -> None:
    """An as-of after the restatement is knowable returns the RESTATED value (402)."""
    after = ms(2024, 9, 1)
    out = await _resolver(lake).get_pit_fundamentals(["NEWT_US_EQ"], after)
    assert out["NEWT_US_EQ"].line_items["total_revenue"] == 402.0


@pytest.mark.asyncio
async def test_as_of_before_first_print_is_empty(lake: Path) -> None:
    """Before anything was knowable → empty dict, null provenance (never a fabricated value)."""
    before = ms(2023, 1, 1)
    out = await _resolver(lake).get_pit_fundamentals(["NEWT_US_EQ"], before)
    assert out["NEWT_US_EQ"].line_items == {}
    assert out["NEWT_US_EQ"].source is None


# ── non-US fail-closed (Thread C) ─────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_non_us_name_is_empty_no_yahoo(lake: Path) -> None:
    """An LSE name → `{}` (the lake resolves only US/EDGAR; NO Yahoo fallback). The dict is empty and
    the provenance is null — fail-closed, never an error."""
    out = await _resolver(lake).get_pit_fundamentals(["SHELl_EQ"], AS_OF)
    assert out["SHELl_EQ"].line_items == {}
    assert out["SHELl_EQ"].source is None


@pytest.mark.asyncio
async def test_unknown_us_name_is_empty(lake: Path) -> None:
    """A US ticker not in the lake → `{}` (cold/unknown CIK), never a fabricated value."""
    out = await _resolver(lake).get_pit_fundamentals(["ZZZZ_US_EQ"], AS_OF)
    assert out["ZZZZ_US_EQ"].line_items == {}
    assert out["ZZZZ_US_EQ"].source is None


@pytest.mark.asyncio
async def test_empty_ticker_list_returns_empty(lake: Path) -> None:
    out = await _resolver(lake).get_pit_fundamentals([], AS_OF)
    assert out == {}


# ── the SECTOR-TEMPLATE threading (the Task-6 gotcha this card wires) ──────────────────────────────────
@pytest.mark.asyncio
async def test_bank_sector_override_resolves_net_interest_revenue(lake: Path) -> None:
    """The bank's top line resolves from RevenuesNetOfInterestExpense (the registry sector override),
    NOT the manufacturer default Revenues tag (which the bank never files). This ONLY works if the
    entity SIC (6021 → bank template) is threaded through pit_line_items — the whole point of the card's
    sector-threading. A sector-blind read would find no total_revenue for the bank."""
    out = await _resolver(lake).get_pit_fundamentals(["BANK_US_EQ"], AS_OF)
    li = out["BANK_US_EQ"].line_items
    assert li["total_revenue"] == 5000.0  # the net-interest override resolved


@pytest.mark.asyncio
async def test_bank_sector_override_fail_closes_gross_profit(lake: Path) -> None:
    """The bank template's gross_profit / current_assets overrides are EMPTY (a bank has no gross-profit
    line), so a correctly-threaded read OMITS gross_profit even though a GrossProfit fact is physically
    in the file. This proves the empty sector override is honoured (fail-closed), not silently falling
    back to the default tag."""
    out = await _resolver(lake).get_pit_fundamentals(["BANK_US_EQ"], AS_OF)
    li = out["BANK_US_EQ"].line_items
    assert "gross_profit" not in li        # empty bank override ⇒ fail-closed, despite the seeded fact
    assert "current_assets" not in li      # banks run unclassified balance sheets
    assert li["net_income"] == 110.0       # the rest resolves normally


# ── bare-or-T212 acceptance (transition-safe) ─────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_accepts_bare_ticker(lake: Path) -> None:
    """A BARE symbol (no _US_EQ suffix) resolves identically to its T212 form — the seam is
    transition-safe while callers still send T212 (note 1)."""
    out = await _resolver(lake).get_pit_fundamentals(["FULL"], AS_OF)  # bare, not FULL_US_EQ
    assert out["FULL"].line_items["net_income"] == 110.0
    assert out["FULL"].source == SOURCE_PIT_EDGAR


@pytest.mark.asyncio
async def test_legacy_fb_rename_resolves_through_cik(lake: Path) -> None:
    """`identity_of` applies the FB→META rename, so a request for the legacy symbol resolves the
    surviving CIK. (Here OLDT→NEWT is the synthetic rename; the FB→META path is the adapter's own
    rename table, asserted in the identity unit suite — this pins that the resolver's NEWT request
    reaches CIK_ACME via the rename-aware lake resolve.)"""
    out = await _resolver(lake).get_pit_fundamentals(["NEWT_US_EQ"], AS_OF)
    assert out["NEWT_US_EQ"].line_items["net_income"] == 110.0


# ── Redis read-through ────────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_cache_hit_short_circuits_lake(lake: Path) -> None:
    """A second call within the same asOf bucket serves the cached value (the read-through short-circuits
    the lake), even if the underlying lake changed."""
    redis = FakeRedis()
    r = _resolver(lake, redis=redis)
    first = await r.get_pit_fundamentals(["FULL_US_EQ"], AS_OF)
    assert first["FULL_US_EQ"].line_items["net_income"] == 110.0
    assert redis.set_calls == 1  # populated on the miss

    # Build a resolver over an EMPTY lake but the SAME warm cache — the cached entry must still serve.
    empty = lake.parent / "empty_lake"
    empty.mkdir()
    r2 = FundamentalsResolver(Store(empty), redis=redis)
    second = await r2.get_pit_fundamentals(["FULL_US_EQ"], AS_OF)
    assert second["FULL_US_EQ"].line_items["net_income"] == 110.0  # the cached value, not a cold miss


@pytest.mark.asyncio
async def test_cache_failure_falls_through_to_lake(lake: Path) -> None:
    class _BrokenRedis:
        async def get(self, key):
            raise OSError("redis down")

        async def set(self, key, value, ex=None):
            raise OSError("redis down")

    out = await _resolver(lake, redis=_BrokenRedis()).get_pit_fundamentals(["FULL_US_EQ"], AS_OF)
    assert out["FULL_US_EQ"].line_items["net_income"] == 110.0  # a broken cache never blocks the read


# ── Gap-2: market-cap override + dividend-yield leg ───────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_market_cap_computed_from_price_shares_fx(lake: Path) -> None:
    """The resolver fills market_cap_gbp with the computed PIT value (price×shares×fx) and wires the
    dividend_yield leg, all at one as_of. The market-data reads key on the T212 form."""
    md = FakeMarketDataReader()
    md.set_close("FULL_US_EQ", AS_OF, 30.0)
    md.set_fx("USD", 0.79)
    md.set_dividend_yield("FULL_US_EQ", 0.0055)
    out = await _resolver(lake, market_data=md).get_pit_fundamentals(["FULL_US_EQ"], AS_OF)
    li = out["FULL_US_EQ"].line_items
    assert li["market_cap_gbp"] == 30.0 * 50.0 * 0.79
    assert li["dividend_yield"] == 0.0055
    assert md.dividend_calls == [(("FULL_US_EQ",), AS_OF)]  # one batch round-trip


@pytest.mark.asyncio
async def test_market_cap_absent_when_price_missing(lake: Path) -> None:
    """No as-of close → market_cap_gbp ABSENT (NaN-excluded), never fabricated; the rest is intact."""
    md = FakeMarketDataReader()  # no close seeded
    md.set_fx("USD", 0.79)
    out = await _resolver(lake, market_data=md).get_pit_fundamentals(["FULL_US_EQ"], AS_OF)
    assert "market_cap_gbp" not in out["FULL_US_EQ"].line_items
    assert out["FULL_US_EQ"].line_items["net_income"] == 110.0


@pytest.mark.asyncio
async def test_bare_ticker_market_cap_uses_t212_keyed_reads(lake: Path) -> None:
    """A BARE request ticker is mapped to its T212 form for the market-data reads (the bars view keys on
    T212), so the close seeded under `FULL_US_EQ` is found even though the request was bare `FULL`."""
    md = FakeMarketDataReader()
    md.set_close("FULL_US_EQ", AS_OF, 30.0)  # seeded under the T212 form
    md.set_fx("USD", 0.79)
    out = await _resolver(lake, market_data=md).get_pit_fundamentals(["FULL"], AS_OF)  # bare request
    assert out["FULL"].line_items["market_cap_gbp"] == 30.0 * 50.0 * 0.79
    # the batch close read was driven with the T212 form, not the bare symbol.
    assert md.batch_close_calls == [(("FULL_US_EQ",), AS_OF)]


@pytest.mark.asyncio
async def test_no_market_data_reader_leaves_pivot_untouched(lake: Path) -> None:
    """Without a MarketDataReader, the resolver returns the raw lake pivot — market_cap_gbp absent (the
    lake never stores it), never fabricated."""
    out = await _resolver(lake).get_pit_fundamentals(["FULL_US_EQ"], AS_OF)
    assert "market_cap_gbp" not in out["FULL_US_EQ"].line_items
    assert out["FULL_US_EQ"].line_items["net_income"] == 110.0


@pytest.mark.asyncio
async def test_unresolved_name_excluded_from_market_data_reads(lake: Path) -> None:
    """An unresolved name (non-US / unknown) is passed through untouched AND excluded from the coalesced
    upstream reads (nothing to value)."""
    md = FakeMarketDataReader()
    md.set_close("SHELl_EQ", AS_OF, 12.5)
    out = await _resolver(lake, market_data=md).get_pit_fundamentals(["SHELl_EQ"], AS_OF)
    assert out["SHELl_EQ"].line_items == {}
    assert md.batch_close_calls == [((), AS_OF)]   # called with NO tickers
    assert md.dividend_calls == [((), AS_OF)]
    assert md.fx_calls == []


@pytest.mark.asyncio
async def test_live_read_resolves_current_facts(lake: Path) -> None:
    """A live (asOf-less) read maps to 'as of now' — every fact in the lake is knowable, so a covered
    name resolves. (The lake has no is_superseded fast lane; live IS knowledge_ts ≤ now.)"""
    out = await _resolver(lake).get_pit_fundamentals(["FULL_US_EQ"], None)
    assert out["FULL_US_EQ"].line_items["net_income"] == 110.0
    assert out["FULL_US_EQ"].line_items["total_revenue"] == 1000.0


# ── identity helpers (bare/T212/rename) ───────────────────────────────────────────────────────────────
def test_identity_of_accepts_t212_and_bare() -> None:
    assert identity_of("AAPL_US_EQ") == identity_of("AAPL")            # T212 and bare → same US identity
    assert identity_of("AAPL").market == "US"                          # bare defaults to US
    assert identity_of("SHELl_EQ").market == "LSE"                     # T212 LSE
    assert identity_of("") is None                                     # empty → None
    assert identity_of("FB_US_EQ").symbol == "META"                    # FB→META rename applied


def test_t212_of_renders_bare_to_t212_and_keeps_t212() -> None:
    assert t212_of("AAPL_US_EQ", identity_of("AAPL_US_EQ")) == "AAPL_US_EQ"  # already T212 → verbatim
    assert t212_of("AAPL", identity_of("AAPL")) == "AAPL_US_EQ"              # bare → T212 for the reads
