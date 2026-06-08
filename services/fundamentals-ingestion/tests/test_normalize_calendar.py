"""NYSE next-session-open availability tests — the PIT `knowledge_ts` derivation (epic Task 7).

The headline contract: a filing accepted AFTER the 16:00 ET close is knowable at the NEXT session's
09:30 ET open, never the session it landed after (the 18:12-ET-Friday → Monday-open case the plan
names). Proves the UTC→ET conversion (EST/EDT + the DST boundaries), the pre-open vs intraday vs
after-hours bucketing, the weekend + holiday roll, and the rule-based historical holiday computation
(a fundamentals backfill spans decades, so holidays are computed for every year, not a 2-year table).

All expected opens are 09:30 ET expressed in UTC: EST → 14:30 UTC, EDT → 13:30 UTC. Validated values
(no tzdata dependency — the helper carries the Eastern DST rule + rule-based NYSE full closures).
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from src.normalize.calendar import next_session_open_ms


def _ms(dt_str: str) -> int:
    """A 'YYYY-MM-DD HH:MM' UTC wall-clock string → epoch ms."""
    return int(
        datetime.strptime(dt_str, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp() * 1000
    )


def _open_iso(accepted_utc: str) -> str:
    """The derived session-open as an ISO-8601 UTC string (for readable assertions)."""
    out = next_session_open_ms(_ms(accepted_utc))
    return datetime.fromtimestamp(out / 1000, tz=timezone.utc).isoformat()


# ── the headline: after-hours acceptance → NEXT session ────────────────────────
def test_after_hours_accept_rolls_to_next_session_open() -> None:
    # 2026-06-08 is a Monday in EDT. 18:12 ET = 22:12 UTC (after the 16:00 close) → Tuesday's 09:30 ET
    # open = 2026-06-09 13:30 UTC. The whole point: NOT the same session it landed after close.
    assert _open_iso("2026-06-08 22:12") == "2026-06-09T13:30:00+00:00"


def test_friday_after_hours_accept_rolls_to_monday_open() -> None:
    # The plan's canonical example: a fact accepted 18:12 ET on a Friday becomes knowable at Monday's
    # open. 2026-06-05 Fri 22:12 UTC → 2026-06-08 Mon 13:30 UTC.
    assert _open_iso("2026-06-05 22:12") == "2026-06-08T13:30:00+00:00"


# ── pre-open vs intraday ───────────────────────────────────────────────────────
def test_pre_open_accept_is_same_session_open() -> None:
    # Accepted BEFORE 09:30 ET on a trading day → THAT day's open (a pre-open accept is knowable at the
    # open it precedes). 2026-06-08 Mon 09:00 ET = 13:00 UTC < 13:30 UTC open → same Monday open.
    assert _open_iso("2026-06-08 13:00") == "2026-06-08T13:30:00+00:00"


def test_intraday_accept_rolls_to_next_session() -> None:
    # Accepted AT/AFTER the open (10:00 ET) → the NEXT session's open (you couldn't trade the open that
    # had already passed). 2026-06-08 Mon 10:00 ET = 14:00 UTC → Tuesday 2026-06-09 13:30 UTC.
    assert _open_iso("2026-06-08 14:00") == "2026-06-09T13:30:00+00:00"


def test_accept_exactly_at_open_rolls_to_next_session() -> None:
    # Boundary: accepted at EXACTLY 09:30 ET. The fact is not knowable at an open that is simultaneous
    # with (not strictly after) the accept — it rolls to the next session. 13:30 UTC == the open instant.
    assert _open_iso("2026-06-08 13:30") == "2026-06-09T13:30:00+00:00"


# ── weekend + holiday rolls ─────────────────────────────────────────────────────
def test_holiday_and_weekend_roll_to_next_trading_day() -> None:
    # Accepted Thu 2026-07-02 after close. 2026-07-03 is the (observed) Independence Day full closure,
    # 07-04 Sat, 07-05 Sun → the next OPEN is Mon 2026-07-06 13:30 UTC. Proves the holiday table + the
    # weekend skip compose.
    assert _open_iso("2026-07-02 22:00") == "2026-07-06T13:30:00+00:00"


def test_accept_on_a_holiday_rolls_forward() -> None:
    # Accepted ON Christmas 2026-12-25 (a Friday full closure) → the next trading day is Mon 2026-12-28
    # 14:30 UTC (EST in December). A closure day is never its own session.
    assert _open_iso("2026-12-25 12:00") == "2026-12-28T14:30:00+00:00"


# ── EST/EDT offset correctness ──────────────────────────────────────────────────
def test_est_window_open_is_1430_utc() -> None:
    # January = EST (UTC-5): 09:30 ET = 14:30 UTC. 2026-01-05 Mon 09:00 ET = 14:00 UTC (pre-open) → same
    # Monday open at 14:30 UTC.
    assert _open_iso("2026-01-05 14:00") == "2026-01-05T14:30:00+00:00"


def test_edt_window_open_is_1330_utc() -> None:
    # June = EDT (UTC-4): 09:30 ET = 13:30 UTC (asserted throughout above). One explicit check.
    assert _open_iso("2026-06-08 13:00") == "2026-06-08T13:30:00+00:00"


def test_dst_spring_forward_boundary() -> None:
    # 2026 spring-forward is Sun 2026-03-08 (2nd Sunday of March); Mon 2026-03-09 is the first EDT
    # session → open 13:30 UTC. Accepted 09:00 ET = 13:00 UTC (pre-open) → same-day 13:30 UTC.
    assert _open_iso("2026-03-09 13:00") == "2026-03-09T13:30:00+00:00"


def test_dst_fall_back_boundary() -> None:
    # 2026 fall-back is Sun 2026-11-01 (1st Sunday of November); Mon 2026-11-02 is back to EST → open
    # 14:30 UTC. Accepted 09:00 ET = 14:00 UTC (pre-open) → same-day 14:30 UTC.
    assert _open_iso("2026-11-02 14:00") == "2026-11-02T14:30:00+00:00"


# ── rule-based historical holidays (a backfill spans decades) ───────────────────
def test_historical_good_friday_rolls() -> None:
    # 2020-04-10 was Good Friday (NYSE closed) — computed via the Easter rule, no static table. A fact
    # accepted Thu 2020-04-09 after close rolls past Good Friday + the weekend to Mon 2020-04-13.
    # 2020-04-13 is EDT → 13:30 UTC.
    assert _open_iso("2020-04-09 22:00") == "2020-04-13T13:30:00+00:00"


def test_juneteenth_only_from_2022() -> None:
    # Juneteenth became a market holiday only in 2022. 2021-06-18 (Fri) was a NORMAL trading day, so a
    # Thu 2021-06-17 after-hours accept is knowable Fri 2021-06-18. In 2022 the observed Juneteenth
    # (Mon 2022-06-20, the 19th is a Sunday) IS a closure, so a Fri 2022-06-17 after-hours accept rolls
    # past the weekend AND Monday to Tue 2022-06-21.
    assert _open_iso("2021-06-17 22:00") == "2021-06-18T13:30:00+00:00"   # no Juneteenth in 2021
    assert _open_iso("2022-06-17 22:00") == "2022-06-21T13:30:00+00:00"   # Juneteenth observed 2022


def test_new_year_on_saturday_does_not_close_preceding_friday() -> None:
    # The NYSE asymmetric rule: when Jan 1 falls on a Saturday, the market does NOT close the preceding
    # Friday (Dec 31). Jan 1 2022 was a Saturday → 2021-12-31 (Fri) was a trading day. A Thu 2021-12-30
    # after-hours accept is knowable Fri 2021-12-31, not the following Monday.
    assert _open_iso("2021-12-30 22:00") == "2021-12-31T14:30:00+00:00"   # EST → 14:30 UTC
