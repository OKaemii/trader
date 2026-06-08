"""As-of resolver tests — the PIT read core (epic Task 11).

Proves the headline guarantee + the supporting invariants against the in-memory FakeTimescale (which
reproduces EXACTLY the resolver's live / as-of SQL, including the `knowledge_ts <= asOf` guard):

  * get_pit_fundamentals at a PAST as_of returns ONLY facts with knowledge_ts ≤ as_of (no look-ahead);
  * a restatement shows the ORIGINAL value at the original as_of and the RESTATED value at a later as_of
    (the bi-temporal supersede the write-side lands, read as-of);
  * the pivot produces the snake_case LINE_ITEMS dict (latest observation per metric), with provenance;
  * the LIVE path (no asOf) reads the is_superseded=FALSE fast lane;
  * an unresolved ticker, or a covered name with no fact ≤ asOf, degrades to {} (never a fabricated value);
  * segment facts (dim_signature != '') are excluded from the consolidated line-item dict;
  * the Redis read-through short-circuits Postgres on a hit, and a cache failure falls through to the DB;
  * ticker → instrument_id resolves AS-OF (the FB→META effective-dated case).

No network, no DB.
"""
from __future__ import annotations

import pytest

from src.resolver import FundamentalsResolver
from src.security_master import SecurityMasterResolver
from tests.fakes import FakeMarketDataReader, FakeRedis, FakeTimescale

# Fixed knowledge-time instants (UTC ms) for readability.
_T2018 = 1_500_000_000_000   # ~2017-07 — an early period
_KNOW_ORIG = 1_580_000_000_000     # ~2020-01-25 — first-print availability
_KNOW_RESTATE = 1_610_000_000_000  # ~2021-01-07 — a later 10-K/A availability
_AS_OF_MID = 1_600_000_000_000     # ~2020-09-13 — between first-print and restatement
_AS_OF_LATE = 1_620_000_000_000    # ~2021-05-03 — after the restatement
_AS_OF_EARLY = 1_550_000_000_000   # ~2019-02-14 — before the first-print


def _resolver(db: FakeTimescale, redis=None) -> FundamentalsResolver:
    return FundamentalsResolver(db, SecurityMasterResolver(db), redis=redis)


# ── no look-ahead ────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_as_of_returns_only_knowledge_ts_leq_as_of() -> None:
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ", cik="0000320193")
    # A fact knowable BEFORE the asOf and one knowable AFTER it (a filing accepted later).
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=100.0)
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018 + 1,
                knowledge_ts=_KNOW_RESTATE, value=999.0)  # knowable only after the restatement date

    out = await _resolver(db).get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_MID)
    tf = out["AAPL_US_EQ"]
    # Only the knowledge_ts ≤ asOf fact is visible; the later-knowable 999.0 is NOT returned.
    assert tf.line_items["net_income"] == 100.0
    assert tf.knowledge_ts == _KNOW_ORIG


@pytest.mark.asyncio
async def test_as_of_before_first_print_is_empty() -> None:
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=100.0)
    out = await _resolver(db).get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_EARLY)
    # Nothing was knowable yet → empty dict, null provenance (never a fabricated value).
    assert out["AAPL_US_EQ"].line_items == {}
    assert out["AAPL_US_EQ"].source is None


# ── restatement: original at original as_of, restated at later as_of ─────────────
@pytest.mark.asyncio
async def test_restatement_original_value_at_original_as_of_restated_later() -> None:
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    # The SAME logical fact (instrument, metric, observation_ts, dim) restated: a first-print row (now
    # superseded) at the original knowledge_ts, and the restated current row at a later knowledge_ts —
    # exactly what the write-side supersede-in-txn lands.
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=100.0, is_superseded=True)
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_RESTATE, value=120.0, is_superseded=False)

    r = _resolver(db)
    # At a date BEFORE the restatement, the as-of read returns the ORIGINALLY-reported value.
    at_mid = await r.get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_MID)
    assert at_mid["AAPL_US_EQ"].line_items["net_income"] == 100.0
    assert at_mid["AAPL_US_EQ"].knowledge_ts == _KNOW_ORIG
    # At a date AFTER the restatement, it returns the RESTATED value.
    at_late = await r.get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_LATE)
    assert at_late["AAPL_US_EQ"].line_items["net_income"] == 120.0
    assert at_late["AAPL_US_EQ"].knowledge_ts == _KNOW_RESTATE


# ── pivot → snake_case LINE_ITEMS dict ───────────────────────────────────────────
@pytest.mark.asyncio
async def test_pivot_produces_snake_case_line_item_dict() -> None:
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    for metric, value in [
        ("net_income", 100.0), ("total_equity", 500.0), ("total_debt", 200.0),
        ("current_assets", 300.0), ("current_liabilities", 150.0),
    ]:
        db.add_fact(instrument_id=10, metric=metric, observation_ts=_T2018,
                    knowledge_ts=_KNOW_ORIG, value=value)
    out = await _resolver(db).get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_MID)
    li = out["AAPL_US_EQ"].line_items
    # Exactly the canonical snake_case keys (drawn from quant_core.fundamentals.LINE_ITEMS), values intact.
    assert li == {
        "net_income": 100.0, "total_equity": 500.0, "total_debt": 200.0,
        "current_assets": 300.0, "current_liabilities": 150.0,
    }


@pytest.mark.asyncio
async def test_pivot_keeps_latest_observation_per_metric() -> None:
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    # Two annual periods of the same metric, both knowable as-of; the pivot keeps the latest period.
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=100.0)
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018 + 31_000_000_000,
                knowledge_ts=_KNOW_ORIG, value=140.0)  # a later fiscal period
    out = await _resolver(db).get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_MID)
    assert out["AAPL_US_EQ"].line_items["net_income"] == 140.0


@pytest.mark.asyncio
async def test_segment_facts_excluded_from_consolidated_dict() -> None:
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    db.add_fact(instrument_id=10, metric="total_revenue", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=1000.0, dim_signature="")          # consolidated
    db.add_fact(instrument_id=10, metric="total_revenue", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=300.0, dim_signature="segment=A")  # a segment fact
    out = await _resolver(db).get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_MID)
    # Only the consolidated total is in the line-item dict.
    assert out["AAPL_US_EQ"].line_items["total_revenue"] == 1000.0


# ── live fast lane ───────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_live_reads_is_superseded_false_fast_lane() -> None:
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=100.0, is_superseded=True)   # old revision
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_RESTATE, value=120.0, is_superseded=False)  # current
    out = await _resolver(db).get_pit_fundamentals(["AAPL_US_EQ"], None)  # None ⇒ live
    assert out["AAPL_US_EQ"].line_items["net_income"] == 120.0  # the current row only


# ── unresolved ticker degrades to {} ─────────────────────────────────────────────
@pytest.mark.asyncio
async def test_unresolved_ticker_is_empty_dict() -> None:
    db = FakeTimescale()  # no instruments seeded
    out = await _resolver(db).get_pit_fundamentals(["NOPE_US_EQ"], _AS_OF_MID)
    assert out["NOPE_US_EQ"].line_items == {}
    assert out["NOPE_US_EQ"].source is None


@pytest.mark.asyncio
async def test_empty_ticker_list_returns_empty() -> None:
    db = FakeTimescale()
    out = await _resolver(db).get_pit_fundamentals([], _AS_OF_MID)
    assert out == {}


# ── FB→META effective-dated resolution feeds the right instrument ────────────────
@pytest.mark.asyncio
async def test_ticker_rename_resolves_fundamentals_as_of() -> None:
    db = FakeTimescale()
    # ONE instrument that was FB then META; facts keyed on the (rename-invariant) instrument_id.
    db.add_instrument(instrument_id=42, t212_ticker="META_US_EQ")
    fb_end = 1_604_000_000_000  # ~2020-10-29 — FB's ticker interval closes / META's opens
    db.add_identifier(instrument_id=42, identifier_value="FB", effective_from=0, effective_to=fb_end)
    db.add_identifier(instrument_id=42, identifier_value="META", effective_from=fb_end, effective_to=None)
    db.add_fact(instrument_id=42, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=777.0)
    # Querying the present ticker "META" at a PAST as_of (when it was FB) still reaches the instrument.
    out = await _resolver(db).get_pit_fundamentals(["META_US_EQ"], _AS_OF_MID)
    assert out["META_US_EQ"].line_items["net_income"] == 777.0


# ── Redis read-through ───────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_cache_hit_short_circuits_postgres() -> None:
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=100.0)
    redis = FakeRedis()
    r = _resolver(db, redis=redis)
    first = await r.get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_MID)
    assert first["AAPL_US_EQ"].line_items["net_income"] == 100.0
    assert redis.set_calls == 1  # populated on the miss

    # Now mutate the DB out from under the cache; a second call within the same asOf bucket must serve
    # the cached value (proving the read-through short-circuits Postgres), not the new DB row.
    db.fundamentals.clear()
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=555.0)
    second = await r.get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_MID)
    assert second["AAPL_US_EQ"].line_items["net_income"] == 100.0  # the cached value, not 555.0


@pytest.mark.asyncio
async def test_cache_failure_falls_through_to_db() -> None:
    class _BrokenRedis:
        async def get(self, key):
            raise OSError("redis down")

        async def set(self, key, value, ex=None):
            raise OSError("redis down")

    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=100.0)
    # A broken cache must NOT block the request — it falls through to Postgres.
    out = await _resolver(db, redis=_BrokenRedis()).get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_MID)
    assert out["AAPL_US_EQ"].line_items["net_income"] == 100.0


# ── Gap-2: market-cap override + dividend-yield leg wired into the resolved payload ───────────────
def _resolver_md(db: FakeTimescale, market_data, redis=None) -> FundamentalsResolver:
    return FundamentalsResolver(db, SecurityMasterResolver(db), redis=redis, market_data=market_data)


@pytest.mark.asyncio
async def test_market_cap_computed_from_price_shares_fx_overrides_provider() -> None:
    """The resolver overrides market_cap_gbp with the computed PIT value (price×shares×fx) — even if a
    provider scalar somehow landed in the warehouse, AND wires the dividend_yield leg, all at one as_of."""
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    db.add_fact(instrument_id=10, metric="shares_outstanding", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=16_000_000_000.0)
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=100_000_000_000.0)
    # A stray provider market-cap scalar in the warehouse — must be OVERRIDDEN, never surfaced.
    db.add_fact(instrument_id=10, metric="market_cap_gbp", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=999_999.0)

    md = FakeMarketDataReader()
    md.set_close("AAPL_US_EQ", _AS_OF_MID, 150.0)       # as-of adjusted close (same series momentum uses)
    md.set_fx("USD", 0.79)                              # the platform's published GBP/USD
    md.set_dividend_yield("AAPL_US_EQ", 0.0055)

    out = await _resolver_md(db, md).get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_MID)
    li = out["AAPL_US_EQ"].line_items
    # market_cap_gbp is the COMPUTED value, NOT the warehouse scalar.
    assert li["market_cap_gbp"] == 150.0 * 16_000_000_000.0 * 0.79
    assert li["market_cap_gbp"] != 999_999.0
    # dividend_yield leg wired in at the same as_of.
    assert li["dividend_yield"] == 0.0055
    # the dividend-yield read was ONE batch round-trip at this as_of.
    assert md.dividend_calls == [(("AAPL_US_EQ",), _AS_OF_MID)]


@pytest.mark.asyncio
async def test_market_cap_absent_when_shares_missing() -> None:
    """No shares_outstanding fact ≤ asOf → market_cap_gbp is ABSENT (NaN-excluded), never fabricated."""
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=100.0)
    md = FakeMarketDataReader()
    md.set_close("AAPL_US_EQ", _AS_OF_MID, 150.0)
    md.set_fx("USD", 0.79)
    out = await _resolver_md(db, md).get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_MID)
    assert "market_cap_gbp" not in out["AAPL_US_EQ"].line_items
    assert out["AAPL_US_EQ"].line_items["net_income"] == 100.0  # the rest is intact


@pytest.mark.asyncio
async def test_market_cap_absent_when_price_missing() -> None:
    """No as-of close (unseeded bar / nothing ≤ asOf) → market_cap_gbp absent, never fabricated."""
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    db.add_fact(instrument_id=10, metric="shares_outstanding", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=16e9)
    md = FakeMarketDataReader()  # no close seeded → adjusted_close_as_of returns None
    md.set_fx("USD", 0.79)
    out = await _resolver_md(db, md).get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_MID)
    assert "market_cap_gbp" not in out["AAPL_US_EQ"].line_items


@pytest.mark.asyncio
async def test_dividend_yield_null_omitted() -> None:
    """A name with no dividend-yield (no price as-of upstream → not in the batch) has no dividend_yield
    leg — never a fabricated 0."""
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=100.0)
    md = FakeMarketDataReader()  # no dividend yield seeded for this ticker
    out = await _resolver_md(db, md).get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_MID)
    assert "dividend_yield" not in out["AAPL_US_EQ"].line_items


@pytest.mark.asyncio
async def test_unresolved_name_excluded_from_market_data_reads() -> None:
    """An unresolved name (no facts) is passed through untouched — there's nothing to value, and we don't
    fabricate a market cap from a price alone. It is also EXCLUDED from the coalesced upstream reads (the
    batch close + dividend-yield carry only the valuable names; no FX is resolved for it)."""
    db = FakeTimescale()  # no instruments
    md = FakeMarketDataReader()
    md.set_close("NOPE_US_EQ", _AS_OF_MID, 150.0)
    md.set_fx("USD", 0.79)
    out = await _resolver_md(db, md).get_pit_fundamentals(["NOPE_US_EQ"], _AS_OF_MID)
    assert out["NOPE_US_EQ"].line_items == {}
    # The unresolved name is excluded from every upstream read — the batch close + dividend-yield are
    # called with NO tickers, and no FX is resolved.
    assert md.batch_close_calls == [((), _AS_OF_MID)]
    assert md.dividend_calls == [((), _AS_OF_MID)]
    assert md.fx_calls == []


@pytest.mark.asyncio
async def test_fx_resolved_once_per_currency_not_per_ticker() -> None:
    """FX is resolved ONCE per distinct currency across the universe (the hot-path coalescing), not once
    per ticker — three USD names share a single USD FX read."""
    db = FakeTimescale()
    md = FakeMarketDataReader()
    md.set_fx("USD", 0.79)
    for i, t in enumerate(["AAA_US_EQ", "BBB_US_EQ", "CCC_US_EQ"], start=1):
        db.add_instrument(instrument_id=i, t212_ticker=t)
        db.add_fact(instrument_id=i, metric="shares_outstanding", observation_ts=_T2018,
                    knowledge_ts=_KNOW_ORIG, value=1e9)
        md.set_close(t, _AS_OF_MID, 100.0)
    out = await _resolver_md(db, md).get_pit_fundamentals(
        ["AAA_US_EQ", "BBB_US_EQ", "CCC_US_EQ"], _AS_OF_MID
    )
    # All three priced.
    for t in ["AAA_US_EQ", "BBB_US_EQ", "CCC_US_EQ"]:
        assert out[t].line_items["market_cap_gbp"] == 100.0 * 1e9 * 0.79
    # FX read exactly once (for USD), not three times; the batch close was one round-trip.
    assert md.fx_calls == ["USD"]
    assert len(md.batch_close_calls) == 1


@pytest.mark.asyncio
async def test_no_market_data_reader_leaves_pivot_untouched() -> None:
    """Without a MarketDataReader (the default), the resolver returns the raw warehouse pivot — no market
    cap is fabricated (the writer never lands market_cap_gbp, so the key is simply absent)."""
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=100.0)
    db.add_fact(instrument_id=10, metric="shares_outstanding", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=16e9)
    out = await _resolver(db).get_pit_fundamentals(["AAPL_US_EQ"], _AS_OF_MID)
    assert "market_cap_gbp" not in out["AAPL_US_EQ"].line_items
    assert out["AAPL_US_EQ"].line_items["net_income"] == 100.0


@pytest.mark.asyncio
async def test_gbp_name_market_cap_uses_identity_fx() -> None:
    """An LSE (GBP) name's market cap uses FX identity (1.0) — the stored close is already GBP."""
    db = FakeTimescale()
    db.add_instrument(instrument_id=20, t212_ticker="VODl_EQ")
    db.add_fact(instrument_id=20, metric="shares_outstanding", observation_ts=_T2018,
                knowledge_ts=_KNOW_ORIG, value=2_000_000_000.0)
    md = FakeMarketDataReader()  # FakeMarketDataReader seeds GBP→1.0 by default
    md.set_close("VODl_EQ", _AS_OF_MID, 12.5)
    out = await _resolver_md(db, md).get_pit_fundamentals(["VODl_EQ"], _AS_OF_MID)
    assert out["VODl_EQ"].line_items["market_cap_gbp"] == 12.5 * 2_000_000_000.0
