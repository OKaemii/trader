"""Tests for the PIT-lake `knowledge_ts` calendar + the per-CIK fact schema (epic Task 3).

`lake.calendar` is THE PIT CRUX: it derives a filing's `knowledge_ts` — the next NYSE session OPEN
at which a fact becomes knowable — so the read filter `knowledge_ts <= :as_of` can never leak a
look-ahead. These tests pin the three behaviours the contract depends on:

  1. **Availability semantics** — an accept strictly BEFORE a session's 09:30 ET open resolves to
     that day's open; an accept AT/AFTER the open, after-hours, or on a weekend/holiday resolves to
     the NEXT trading session's open (the after-hours-18:12-Friday → Monday-open case the contract
     names). Holidays (Good Friday, Thanksgiving, a Saturday-observed July 4) roll forward.
  2. **Bulk-bootstrap fallback look-ahead safety** — when acceptance time is absent (the 15k-CIK
     bulk-zip path), `derive_knowledge_ts(None, filed)` anchors `filed` to that day's 16:00 ET close
     before rolling to the next open, so the result is ALWAYS a later trading session, NEVER the
     filed day itself — strictly look-ahead-safe.
  3. **The holiday rule set reproduces the canonical TS `STATIC_FALLBACK.US` 2026 + 2027 closures
     EXACTLY** (the module docstring's load-bearing claim). The expected lists below are copied
     verbatim from `packages/shared-calendar/src/providers/static-fallback.ts`; if a future edit to
     either calendar diverges from the other, `test_closures_match_ts_static_fallback_*` fails — the
     guard that stops the live write-path and the replay read-path from silently drifting.

Plus a `schema.py` sanity test (column names/types/order are the on-disk contract; `knowledge_ts`
non-null intent). pyarrow is the `quant-core[lake]` extra — the docker gate installs it; the schema
test `importorskip`s it so the pure-stdlib calendar suite still runs where pyarrow is absent.

The ET conversions in the assertions go through the SAME `_to_et` the implementation uses, so a test
asserts "the resolved instant is 09:30 ET on the expected date" rather than hard-coding a UTC epoch
that a future DST-table edit could make brittle. UTC-offset checks (09:30 EST = 14:30 UTC, 09:30 EDT
= 13:30 UTC) are asserted separately and explicitly so a regression in the DST fixed-point is caught.
"""
from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from quant_core.fundamentals.lake.calendar import (
    _is_trading_day,
    _nyse_full_closures,
    _session_open_utc_ms,
    _to_et,
    derive_knowledge_ts,
    next_session_open_ms,
)


# --- helpers ---------------------------------------------------------------------------------------


def _utc_ms(y: int, mo: int, d: int, h: int, mi: int) -> int:
    """A UTC wall-clock instant as a UTC-ms epoch (the unit `next_session_open_ms` consumes)."""
    return int(datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp() * 1000)


def _et_of(ms: int) -> datetime:
    """The naive ET wall-clock datetime of a UTC-ms epoch — via the implementation's own converter."""
    return _to_et(datetime.fromtimestamp(ms / 1000, tz=timezone.utc))


def _assert_open_on(result_ms: int, expected_day: date) -> None:
    """Assert `result_ms` is the 09:30 ET open of `expected_day` (date + wall-time, DST-agnostic)."""
    et = _et_of(result_ms)
    assert et.date() == expected_day, f"resolved to {et.date()}, expected {expected_day}"
    assert (et.hour, et.minute) == (9, 30), f"resolved to {et.hour:02d}:{et.minute:02d} ET, expected 09:30"


def _utc_hhmm(ms: int) -> str:
    """The UTC HH:MM of a UTC-ms epoch (for asserting the DST offset of a resolved open)."""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%H:%M")


# Canonical NYSE full-closure dates, copied verbatim from the TS source of truth
# `packages/shared-calendar/src/providers/static-fallback.ts` (STATIC_FALLBACK.US.<year>.fullClosures).
# The lake's rule-based holiday engine MUST reproduce these exactly (module docstring claim).
TS_STATIC_FALLBACK_US = {
    2026: [
        date(2026, 1, 1),   # New Year's Day
        date(2026, 1, 19),  # MLK Day
        date(2026, 2, 16),  # Presidents Day
        date(2026, 4, 3),   # Good Friday
        date(2026, 5, 25),  # Memorial Day
        date(2026, 6, 19),  # Juneteenth
        date(2026, 7, 3),   # July 4 observed (4th is Saturday)
        date(2026, 9, 7),   # Labor Day
        date(2026, 11, 26),  # Thanksgiving
        date(2026, 12, 25),  # Christmas
    ],
    2027: [
        date(2027, 1, 1),   # New Year's Day
        date(2027, 1, 18),  # MLK Day
        date(2027, 2, 15),  # Presidents Day
        date(2027, 3, 26),  # Good Friday
        date(2027, 5, 31),  # Memorial Day
        date(2027, 6, 18),  # Juneteenth observed (19th is Saturday)
        date(2027, 7, 5),   # Independence Day observed (4th is Sunday)
        date(2027, 9, 6),   # Labor Day
        date(2027, 11, 25),  # Thanksgiving
        date(2027, 12, 24),  # Christmas observed (25th is Saturday)
    ],
}


# --- availability semantics: next_session_open_ms ------------------------------------------------


def test_after_hours_friday_accept_resolves_to_monday_open() -> None:
    """The contract's named case: a 10-K accepted 18:12 ET Friday is knowable Monday's open, never
    the Friday it landed after close."""
    # Fri 2026-05-15 18:12 ET (EDT, UTC-4) = 22:12 UTC.
    accept = _utc_ms(2026, 5, 15, 22, 12)
    assert _et_of(accept).date() == date(2026, 5, 15)  # sanity: the accept really is on the Friday
    _assert_open_on(next_session_open_ms(accept), date(2026, 5, 18))  # Monday


def test_pre_open_same_trading_day_resolves_to_that_days_open() -> None:
    """An accept strictly BEFORE 09:30 ET on a trading day is knowable at THAT day's open."""
    # Tue 2026-05-12 08:00 ET = 12:00 UTC (EDT).
    accept = _utc_ms(2026, 5, 12, 12, 0)
    _assert_open_on(next_session_open_ms(accept), date(2026, 5, 12))


def test_accept_exactly_at_open_resolves_to_next_session() -> None:
    """The boundary is strict (`accepted_ts < open_ms`): an accept AT the 09:30 open is the next
    session, because you could not trade the open that has already passed."""
    at_open = _session_open_utc_ms(date(2026, 5, 12))  # Tue
    _assert_open_on(next_session_open_ms(at_open), date(2026, 5, 13))  # Wed


def test_intraday_accept_resolves_to_next_session() -> None:
    """An accept DURING a session (10:00 ET) is knowable the next session's open."""
    # Tue 2026-05-12 10:00 ET = 14:00 UTC (EDT).
    accept = _utc_ms(2026, 5, 12, 14, 0)
    _assert_open_on(next_session_open_ms(accept), date(2026, 5, 13))


def test_holiday_good_friday_rolls_forward() -> None:
    """An accept after-hours the day before Good Friday rolls past the closed Friday to the next
    session (the following Monday — Easter Monday is NOT a NYSE closure)."""
    # Thu 2026-04-02 20:00 ET = 2026-04-03 00:00 UTC (EDT). Fri 04-03 is Good Friday (closed).
    accept = _utc_ms(2026, 4, 3, 0, 0)
    assert _et_of(accept).date() == date(2026, 4, 2)
    assert not _is_trading_day(date(2026, 4, 3))  # Good Friday closed
    _assert_open_on(next_session_open_ms(accept), date(2026, 4, 6))  # Monday after (NYSE trades)


def test_holiday_thanksgiving_rolls_to_half_day_open() -> None:
    """Thanksgiving is a full closure; the day after is a half-day that STILL opens at 09:30, so an
    after-hours pre-Thanksgiving accept resolves to that half-day's open (availability keys on the
    open, never the early close)."""
    # Wed 2026-11-25 20:00 ET = 2026-11-26 01:00 UTC. Thu 11-26 is Thanksgiving (closed).
    accept = _utc_ms(2026, 11, 26, 1, 0)
    assert not _is_trading_day(date(2026, 11, 26))  # Thanksgiving
    assert _is_trading_day(date(2026, 11, 27))      # half-day, but a trading day
    _assert_open_on(next_session_open_ms(accept), date(2026, 11, 27))  # Black Friday half-day open


def test_holiday_saturday_observed_july4_rolls_forward() -> None:
    """A Saturday-observed July 4 (2026: the 4th is Saturday, observed Friday 07-03). An accept
    after-hours Thursday 07-02 rolls past the observed-holiday Friday to the next session (Monday
    07-06)."""
    # Thu 2026-07-02 20:00 ET = 2026-07-03 00:00 UTC (EDT).
    accept = _utc_ms(2026, 7, 3, 0, 0)
    assert _et_of(accept).date() == date(2026, 7, 2)
    assert not _is_trading_day(date(2026, 7, 3))  # July 4 observed (Saturday-shifted to Friday)
    _assert_open_on(next_session_open_ms(accept), date(2026, 7, 6))  # Monday


# --- DST fixed-point: the resolved open carries the right ET offset --------------------------------


def test_dst_winter_accept_resolves_to_est_open() -> None:
    """An accept in EST (winter) resolves to a 09:30 ET open that is 14:30 UTC (UTC-5). Exercises the
    `_session_anchor_utc_ms` fixed-point on the EST side."""
    # Mon 2026-11-02 08:00 ET (EST, the first weekday after the Nov 1 EDT→EST transition) = 13:00 UTC.
    accept = _utc_ms(2026, 11, 2, 13, 0)
    result = next_session_open_ms(accept)
    _assert_open_on(result, date(2026, 11, 2))
    assert _utc_hhmm(result) == "14:30", "EST 09:30 open must be 14:30 UTC (UTC-5)"


def test_dst_summer_accept_resolves_to_edt_open() -> None:
    """An accept in EDT (summer) resolves to a 09:30 ET open that is 13:30 UTC (UTC-4) — the other
    side of the DST fixed-point."""
    # Tue 2026-07-07 08:00 ET (EDT) = 12:00 UTC.
    accept = _utc_ms(2026, 7, 7, 12, 0)
    result = next_session_open_ms(accept)
    _assert_open_on(result, date(2026, 7, 7))
    assert _utc_hhmm(result) == "13:30", "EDT 09:30 open must be 13:30 UTC (UTC-4)"


def test_dst_spring_forward_morning_accept() -> None:
    """An accept on the EST→EDT spring-forward day itself (2nd Sun of March is 2026-03-08, but that's
    a Sunday; the first trading day in EDT is Mon 03-09) resolves to an EDT 09:30 = 13:30 UTC open."""
    # Mon 2026-03-09 06:00 ET (EDT, UTC-4) = 10:00 UTC, before the open.
    accept = _utc_ms(2026, 3, 9, 10, 0)
    result = next_session_open_ms(accept)
    _assert_open_on(result, date(2026, 3, 9))
    assert _utc_hhmm(result) == "13:30", "post-spring-forward 09:30 open must be 13:30 UTC (EDT)"


# --- bulk-bootstrap fallback: derive_knowledge_ts(None, filed) is look-ahead-safe -----------------


def test_bulk_fallback_friday_filed_resolves_to_monday() -> None:
    """The bulk path has no acceptance time; `filed` is anchored to that day's 16:00 ET close, so a
    Friday-filed fact is knowable Monday's open — never the Friday."""
    result = derive_knowledge_ts(None, date(2026, 5, 15))  # Friday
    _assert_open_on(result, date(2026, 5, 18))  # Monday


def test_bulk_fallback_never_same_day_as_filed() -> None:
    """The load-bearing look-ahead invariant of the bulk path: anchoring `filed` to the 16:00 ET
    CLOSE (> 09:30) guarantees the next-session roll, so the resolved knowledge day is ALWAYS strictly
    after the filed day. Checked across a week of trading days."""
    for d in (date(2026, 5, 11), date(2026, 5, 12), date(2026, 5, 13), date(2026, 5, 14), date(2026, 5, 15)):
        result = derive_knowledge_ts(None, d)
        assert _et_of(result).date() > d, f"filed {d} resolved to {_et_of(result).date()} (not look-ahead-safe)"


def test_bulk_fallback_trading_tuesday_resolves_to_wednesday() -> None:
    """A Tuesday-filed fact (a normal mid-week trading day) is knowable the NEXT session — Wednesday's
    open — not the filed Tuesday."""
    result = derive_knowledge_ts(None, date(2026, 5, 12))  # Tuesday
    _assert_open_on(result, date(2026, 5, 13))  # Wednesday


def test_bulk_fallback_filed_before_holiday_rolls_past_it() -> None:
    """A fact filed the day before Good Friday (Thursday 2026-04-02) rolls past the closed Friday to
    the next trading session (Monday 04-06)."""
    result = derive_knowledge_ts(None, date(2026, 4, 2))  # Thursday before Good Friday
    _assert_open_on(result, date(2026, 4, 6))  # Monday after


def test_acceptance_path_takes_precedence_over_filed() -> None:
    """When acceptance time IS present, `derive_knowledge_ts` uses the precise next-session-open after
    the exact accept instant (ignoring `filed`), matching `next_session_open_ms` directly."""
    # Pre-open Tuesday accept → same-day open; pass a misleading later `filed` to prove it's ignored.
    accept = _utc_ms(2026, 5, 12, 12, 0)  # Tue 08:00 ET, before open
    result = derive_knowledge_ts(accept, date(2030, 1, 1))
    assert result == next_session_open_ms(accept)
    _assert_open_on(result, date(2026, 5, 12))


# --- the holiday rule set reproduces the TS static fallback EXACTLY --------------------------------


@pytest.mark.parametrize("year", [2026, 2027])
def test_closures_match_ts_static_fallback(year: int) -> None:
    """The rule-based NYSE full-closure set equals the canonical TS `STATIC_FALLBACK.US` for the year
    — the docstring's load-bearing claim, asserted so a future calendar edit on either side that
    diverges from the other fails loudly (the live write-path / replay read-path drift guard)."""
    rule_based = sorted(_nyse_full_closures(year))
    expected = sorted(TS_STATIC_FALLBACK_US[year])
    assert rule_based == expected, (
        f"{year}: rule-based closures diverge from TS STATIC_FALLBACK.US.\n"
        f"  rule-based: {[d.isoformat() for d in rule_based]}\n"
        f"  TS table  : {[d.isoformat() for d in expected]}"
    )


def test_closures_are_exactly_ten_per_modern_year() -> None:
    """Both years carry exactly the ten modern NYSE full closures (Juneteenth is in-era from 2022) —
    a count guard so neither an extra nor a dropped holiday slips past the date-by-date match above."""
    assert len(_nyse_full_closures(2026)) == 10
    assert len(_nyse_full_closures(2027)) == 10


def test_saturday_new_year_is_not_shifted_to_friday() -> None:
    """The single asymmetric NYSE rule: New Year's Day on a Saturday is NOT observed the preceding
    Friday (unlike July 4 / Christmas). 2022-01-01 was a Saturday → no closure, and Fri 2021-12-31
    stays a trading day."""
    assert date(2022, 1, 1) not in _nyse_full_closures(2022)  # Saturday New Year — not shifted back
    assert _is_trading_day(date(2021, 12, 31))                # the Friday before stays open


def test_juneteenth_absent_before_2022() -> None:
    """Juneteenth became a market holiday only in 2022; a 2021 backfill must not close June 18/19."""
    closures_2021 = _nyse_full_closures(2021)
    assert date(2021, 6, 18) not in closures_2021
    assert date(2021, 6, 19) not in closures_2021  # a Saturday anyway, but the rule must not add it
    assert date(2022, 6, 19) in _nyse_full_closures(2022) or date(2022, 6, 20) in _nyse_full_closures(2022)


# --- schema.py sanity (pyarrow = the [lake] extra; importorskip where absent) ---------------------


def test_schema_columns_names_types_and_order() -> None:
    """The per-CIK fact schema is the on-disk contract: the harvester writes exactly these columns in
    this order and the DuckDB read engine reads them by name. Pin the full (name, type) sequence so a
    reorder/rename/retype is a deliberate, reviewed change — not an accident that silently breaks the
    parquet read."""
    pa = pytest.importorskip("pyarrow")
    from quant_core.fundamentals.lake.schema import SCHEMA

    expected = [
        ("cik", pa.int32()),
        ("taxonomy", pa.string()),
        ("concept", pa.string()),
        ("unit", pa.string()),
        ("start", pa.date32()),
        ("end", pa.date32()),
        ("value", pa.float64()),
        ("fy", pa.int16()),
        ("fp", pa.string()),
        ("form", pa.string()),
        ("accession", pa.string()),
        ("filed", pa.date32()),
        ("accepted_ts", pa.int64()),
        ("knowledge_ts", pa.int64()),
        ("frame", pa.string()),
    ]
    assert SCHEMA.names == [name for name, _ in expected]
    for name, typ in expected:
        assert SCHEMA.field(name).type == typ, f"{name}: {SCHEMA.field(name).type} != {typ}"


def test_schema_knowledge_ts_is_the_read_axis_and_present() -> None:
    """`knowledge_ts` is the PIT read axis (the filter `knowledge_ts <= :as_of`) and must exist as a
    UTC-ms int64. `accepted_ts` is the nullable companion (the bulk path has none); both are int64
    epoch-ms columns. (pyarrow's `Field.nullable` defaults True for schema-level fields, so the
    NON-null intent is enforced by the writer/derivation, not the schema flag — asserted via the
    `derive_knowledge_ts` look-ahead tests above; here we pin the column's presence + type.)"""
    pytest.importorskip("pyarrow")
    import pyarrow as pa

    from quant_core.fundamentals.lake.schema import SCHEMA

    assert SCHEMA.field("knowledge_ts").type == pa.int64()
    assert SCHEMA.field("accepted_ts").type == pa.int64()
