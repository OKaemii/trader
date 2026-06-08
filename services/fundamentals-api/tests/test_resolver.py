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
from tests.fakes import FakeRedis, FakeTimescale

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
