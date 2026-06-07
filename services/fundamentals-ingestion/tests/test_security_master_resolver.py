"""Effective-dated resolution tests — the headline of epic Task 4.

The canonical acceptance is `resolve_symbol("META", 2019-01-01)` returning the FB-era instrument (and
its CIK), proving the ticker-change history is honoured. Tested two ways:
  1. the pure interval rule (`intervals.resolve_interval`) directly, exhaustively — including the
     read-time closure that makes FB's interval end where META's begins even when neither row stored
     an explicit `effective_to` (the append-only path);
  2. the full `SecurityMasterWriter` → `SecurityMasterResolver` round-trip over the in-memory fake DB,
     which is the "rows land in `security_master.*` AND `resolve_symbol` works" end-to-end check.

These run with no Postgres: the rule is pure, and the resolver/writer talk to `FakeTimescale`.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from src.security_master.intervals import (
    IdentifierInterval,
    resolve_instrument_id,
    resolve_interval,
)
from src.security_master.resolver import SecurityMasterResolver, pad_cik
from src.security_master.writers import (
    CompanyRecord,
    IdentifierRecord,
    InstrumentRecord,
    SecurityMasterWriter,
)
from tests.fakes import FakeTimescale


def _ms(year: int, month: int = 1, day: int = 1) -> int:
    return int(datetime(year, month, day, tzinfo=timezone.utc).timestamp() * 1000)


# Facebook → Meta ticker change effective 2022-06-09.
META_RENAME_MS = _ms(2022, 6, 9)
META_CIK = "0001326801"  # Meta Platforms / Facebook EDGAR CIK (zero-padded).


def _meta_intervals(*, close_fb: bool) -> list[IdentifierInterval]:
    """Two ticker intervals for ONE instrument: FB then META. `close_fb` toggles whether the FB row
    stored an explicit `effective_to` (insert-time closure) or was left open (read-time closure) —
    both must resolve identically, which is the append-only invariant."""
    base = dict(instrument_id=1, identifier_type="ticker", company_id=1, t212_ticker="META_US_EQ", cik=META_CIK)
    return [
        IdentifierInterval(
            identifier_value="FB", effective_from=_ms(2012, 5, 18),
            effective_to=(META_RENAME_MS if close_fb else None), **base,
        ),
        IdentifierInterval(
            identifier_value="META", effective_from=META_RENAME_MS, effective_to=None, **base,
        ),
    ]


# ── pure interval rule ───────────────────────────────────────────────────────
@pytest.mark.parametrize("close_fb", [True, False], ids=["explicit-close", "read-time-close"])
def test_resolve_interval_fb_meta_as_of(close_fb: bool) -> None:
    rows = _meta_intervals(close_fb=close_fb)

    # 2019: FB era — "META" asked as-of 2019 resolves the SAME instrument (id 1), and so does "FB".
    fb_2019 = resolve_interval(rows, "FB", _ms(2019, 1, 1))
    meta_2019 = resolve_interval(rows, "META", _ms(2019, 1, 1))
    assert fb_2019 is not None and fb_2019.instrument_id == 1
    assert fb_2019.identifier_value == "FB"
    # "META" as-of 2019: META's own interval starts in 2022, so the META *value* is not valid in 2019.
    # The instrument is still discoverable via the FB value; META-the-string is simply not yet in force.
    assert meta_2019 is None

    # 2023: META era — "META" resolves; "FB" no longer does (its interval closed at the rename).
    fb_2023 = resolve_interval(rows, "FB", _ms(2023, 1, 1))
    meta_2023 = resolve_interval(rows, "META", _ms(2023, 1, 1))
    assert fb_2023 is None
    assert meta_2023 is not None and meta_2023.instrument_id == 1 and meta_2023.identifier_value == "META"


@pytest.mark.parametrize("close_fb", [True, False], ids=["explicit-close", "read-time-close"])
def test_resolve_instrument_id_headline_name_today_ask_past(close_fb: bool) -> None:
    # The plan headline: BOTH "FB" and "META" asked as-of 2019 resolve to the SAME instrument; "META"
    # gets there via the present-identity fallback even though the string wasn't the 2019 ticker.
    rows = _meta_intervals(close_fb=close_fb)
    assert resolve_instrument_id(rows, "FB", _ms(2019, 1, 1)) == 1     # strict in-interval
    assert resolve_instrument_id(rows, "META", _ms(2019, 1, 1)) == 1   # identity fallback
    assert resolve_instrument_id(rows, "META", _ms(2023, 1, 1)) == 1   # strict in-interval (post-rename)
    assert resolve_instrument_id(rows, "FB", _ms(2023, 1, 1)) == 1     # FB still names the instrument
    # An entirely unknown ticker resolves to nothing.
    assert resolve_instrument_id(rows, "NVDA", _ms(2019, 1, 1)) is None


def test_resolve_interval_boundary_belongs_to_new_value() -> None:
    rows = _meta_intervals(close_fb=False)
    # At exactly the rename instant, the NEW value is in force (half-open [from,to)).
    assert resolve_interval(rows, "FB", META_RENAME_MS) is None
    at_meta = resolve_interval(rows, "META", META_RENAME_MS)
    assert at_meta is not None and at_meta.identifier_value == "META"
    # One ms before the rename, FB is still in force.
    assert resolve_interval(rows, "META", META_RENAME_MS - 1) is None
    assert resolve_interval(rows, "FB", META_RENAME_MS - 1) is not None


def test_resolve_interval_before_any_history_is_none() -> None:
    rows = _meta_intervals(close_fb=False)
    # Before FB's effective_from (pre-IPO) nothing resolves.
    assert resolve_interval(rows, "FB", _ms(2010, 1, 1)) is None


def test_resolve_interval_explicit_close_creates_a_gap() -> None:
    # A delisting gap: value valid [2015,2018) explicitly closed, successor only from 2020 — the
    # 2019 hole resolves to nothing (explicit close wins over the successor-derived bound).
    rows = [
        IdentifierInterval(instrument_id=7, identifier_type="ticker", identifier_value="OLD",
                           effective_from=_ms(2015), effective_to=_ms(2018),
                           company_id=7, t212_ticker="OLD_US_EQ", cik=None),
        IdentifierInterval(instrument_id=7, identifier_type="ticker", identifier_value="NEW",
                           effective_from=_ms(2020), effective_to=None,
                           company_id=7, t212_ticker="OLD_US_EQ", cik=None),
    ]
    assert resolve_interval(rows, "OLD", _ms(2016)) is not None
    assert resolve_interval(rows, "OLD", _ms(2019)) is None   # in the gap
    assert resolve_interval(rows, "NEW", _ms(2019)) is None   # NEW not yet in force
    assert resolve_interval(rows, "NEW", _ms(2021)) is not None


def test_resolve_interval_recycled_symbol_picks_latest_assertion() -> None:
    # Same string on two different instruments at different times (a recycled ticker). The as-of must
    # pick the interval whose window contains the instant — not blend them.
    rows = [
        IdentifierInterval(instrument_id=10, identifier_type="ticker", identifier_value="ZZ",
                           effective_from=_ms(2000), effective_to=_ms(2005),
                           company_id=10, t212_ticker="ZZ_US_EQ", cik="0000000010"),
        IdentifierInterval(instrument_id=11, identifier_type="ticker", identifier_value="ZZ",
                           effective_from=_ms(2015), effective_to=None,
                           company_id=11, t212_ticker="ZZ_US_EQ", cik="0000000011"),
    ]
    early = resolve_interval(rows, "ZZ", _ms(2003))
    late = resolve_interval(rows, "ZZ", _ms(2020))
    assert early is not None and early.instrument_id == 10
    assert late is not None and late.instrument_id == 11


# ── full writer → resolver round-trip (rows land in security_master.*) ───────
@pytest.mark.asyncio
async def test_resolve_symbol_meta_2019_returns_fb_era_instrument() -> None:
    db = FakeTimescale()
    writer = SecurityMasterWriter(db)
    resolver = SecurityMasterResolver(db)

    company_id = await writer.upsert_company(
        CompanyRecord(name="Meta Platforms, Inc.", country="US", cik=META_CIK)
    )
    instrument_id = await writer.upsert_instrument(
        InstrumentRecord(company_id=company_id, instrument_type="common",
                         exchange="Nasdaq", currency="USD", t212_ticker="META_US_EQ")
    )
    # Record the rename append-only: FB closed at the rename instant, META open after it.
    await writer.record_ticker_change(
        instrument_id, old_ticker="FB", new_ticker="META",
        changed_at_ms=META_RENAME_MS, old_effective_from=_ms(2012, 5, 18),
    )

    # THE CANONICAL CARD ACCEPTANCE (plan line 614/816): resolve_symbol("META", 2019-01-01) returns
    # the FB-era instrument (so its 2019 fundamentals can be read). META reaches it via the
    # present-identity fallback; valid_at_as_of=False flags that "META" wasn't the literal 2019 ticker.
    meta_2019 = await resolver.resolve_symbol("META", _ms(2019, 1, 1))
    assert meta_2019 is not None
    assert meta_2019.instrument_id == instrument_id
    assert meta_2019.cik == META_CIK
    assert meta_2019.t212_ticker == "META_US_EQ"
    assert meta_2019.valid_at_as_of is False        # "META" was not the 2019 ticker (identity hop)

    # "FB" asked as-of 2019 returns the SAME instrument, and the string WAS in force then.
    fb_2019 = await resolver.resolve_symbol("FB", _ms(2019, 1, 1))
    assert fb_2019 is not None
    assert fb_2019.instrument_id == instrument_id
    assert fb_2019.valid_at_as_of is True

    # META resolves the same instrument today, in-interval.
    meta_now = await resolver.resolve_symbol("META", _ms(2023, 1, 1))
    assert meta_now is not None and meta_now.instrument_id == instrument_id
    assert meta_now.valid_at_as_of is True

    # FB after the rename still NAMES the instrument (identity hop), flagged not-in-force.
    fb_2023 = await resolver.resolve_symbol("FB", _ms(2023, 1, 1))
    assert fb_2023 is not None and fb_2023.instrument_id == instrument_id
    assert fb_2023.valid_at_as_of is False

    # An unknown ticker resolves to nothing.
    assert await resolver.resolve_symbol("NVDA", _ms(2019, 1, 1)) is None


@pytest.mark.asyncio
async def test_resolve_cik_pads_to_ten_digits() -> None:
    db = FakeTimescale()
    writer = SecurityMasterWriter(db)
    resolver = SecurityMasterResolver(db)
    # Store the CIK un-padded; resolve_cik must return the 10-digit EDGAR-path form.
    cid = await writer.upsert_company(CompanyRecord(name="Apple Inc.", country="US", cik="320193"))
    iid = await writer.upsert_instrument(
        InstrumentRecord(company_id=cid, instrument_type="common", t212_ticker="AAPL_US_EQ")
    )
    await writer.append_identifier(
        IdentifierRecord(instrument_id=iid, identifier_type="ticker",
                         identifier_value="AAPL", effective_from=_ms(1980), effective_to=None)
    )
    # In-interval and before-interval BOTH return the CIK: the CIK is a time-invariant company
    # property the EDGAR downloader keys on, so naming the instrument by its ticker is enough — the
    # as_of governs which FACTS are read, not whether the company has a CIK.
    assert await resolver.resolve_cik("AAPL", _ms(2020)) == "0000320193"
    assert await resolver.resolve_cik("AAPL", _ms(1970)) == "0000320193"
    # A ticker that names no instrument at all → no CIK.
    assert await resolver.resolve_cik("NOSUCH", _ms(2020)) is None


@pytest.mark.asyncio
async def test_resolve_instrument_by_t212_ticker() -> None:
    db = FakeTimescale()
    writer = SecurityMasterWriter(db)
    resolver = SecurityMasterResolver(db)
    cid = await writer.upsert_company(CompanyRecord(name="Microsoft", country="US", cik="789019"))
    iid = await writer.upsert_instrument(
        InstrumentRecord(company_id=cid, instrument_type="common", t212_ticker="MSFT_US_EQ")
    )
    # No effective-dated ticker rows: resolve_instrument falls back to the direct t212 lookup.
    resolved = await resolver.resolve_instrument("MSFT_US_EQ")
    assert resolved is not None and resolved.instrument_id == iid
    assert await resolver.resolve_instrument("NOSUCH_US_EQ") is None


def test_pad_cik_forms() -> None:
    assert pad_cik("320193") == "0000320193"
    assert pad_cik("0000320193") == "0000320193"
    assert pad_cik("1045810") == "0001045810"
    assert pad_cik("not-a-cik") == "not-a-cik"  # surfaced unchanged, not mangled
