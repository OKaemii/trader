"""Minimal NYSE trading-session calendar — the `knowledge_ts` availability derivation (epic Task 7).

THE PIT CRUX. A filing's raw `accepted_ts` (EDGAR `acceptanceDateTime`, genuine UTC — Task 4 verified
the literal Z) is WHEN SEC accepted it, not when a trader could act on it. EDGAR routinely accepts
after the 16:00 ET close (a 10-K accepted 18:12 ET Friday). The point-in-time contract is that such a
fact only becomes KNOWABLE at the next session a trader could trade on — Monday's 09:30 ET open, never
the Friday it landed after close. So `fundamentals.knowledge_ts` = the next NYSE session OPEN at or
after `accepted_ts`. A fact accepted DURING a session (10:00 ET) is knowable the NEXT session's open
(you couldn't trade the open that already passed); a fact accepted strictly BEFORE the open is knowable
at that day's open.

WHY a hand-rolled calendar (the note the task asks for):
  * `@trader/shared-calendar` (NYSE/LSE `ExchangeCalendar`, `nextOpen`) is TypeScript — NOT reachable
    from this Python service. quant-core has no Python trading calendar either (its `RebalanceClock`
    deliberately derives month boundaries from the bar stream to stay calendar-free + parity-safe), and
    `pandas_market_calendars`/`exchange_calendars` are NOT dependencies of the python gate (a pure
    pytest image). Per the Task-7 brief, this is the documented minimal NYSE-session next-open helper.
  * Self-contained UTC→ET (no `zoneinfo`/system tzdata — `python:3.12-slim` ships none) via the US
    Eastern DST rule: EDT (UTC-4) from the 2nd-Sunday-of-March 02:00 local to the 1st-Sunday-of-November
    02:00 local; EST (UTC-5) otherwise. The DST transition only shifts the wall-clock offset; the SESSION
    is 09:30–16:00 ET on every trading day regardless, so the derivation only needs the offset + the
    session-open wall time + the weekend/holiday closures.

HOLIDAYS ARE COMPUTED BY RULE, not a static table — because a fundamentals backfill ingests DECADES of
filings (a 10-K from 2010 is the common case, not the exception), so a forward-only 2-year table (what
the TS `STATIC_FALLBACK.US` carries for the live POLL gate) is the wrong shape here. The ten modern
NYSE full closures are almost entirely algorithmic:
  * New Year's Day (Jan 1), Independence Day (Jul 4), Christmas (Dec 25) — fixed, with the NYSE
    weekend-observance rule (Sat → preceding Fri, Sun → following Mon) — EXCEPT New Year's on a
    Saturday, which NYSE does NOT move to Dec 31 (the preceding Friday stays a trading day; the only
    asymmetric case).
  * MLK Day (3rd Mon Jan), Presidents Day (3rd Mon Feb), Memorial Day (last Mon May), Labor Day
    (1st Mon Sep), Thanksgiving (4th Thu Nov) — nth-weekday.
  * Good Friday — 2 days before Easter Sunday (anonymous-Gregorian computus).
  * Juneteenth (Jun 19, observed) — only from 2022 (its first observance as a market holiday).
This rule set reproduces the canonical TS `STATIC_FALLBACK.US` 2026 + 2027 closures EXACTLY (asserted
in the tests) and is correct back through the modern-rules era. HALF-DAYS ARE IRRELEVANT here: a
half-day still OPENS at 09:30 ET — only the close is early — so availability (which keys on the OPEN)
is unaffected.

KNOWN GAP (documented, not faked): one-off ad-hoc NYSE closures that are NOT rule-based — national days
of mourning (e.g. 2018-12-05 G.H.W. Bush), 9/11 (2001-09-11…14), Hurricane Sandy (2012-10-29/30) — are
NOT modelled. A filing accepted ON one of those exact days (then rolled forward one too few sessions)
is the only error, bounded to a single session of availability optimism on a handful of historical
days, and never a look-ahead the other direction. If a backtest is ever found sensitive to one, add it
to `_AD_HOC_CLOSURES`.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from functools import lru_cache

# NYSE regular session open, ET wall-clock. The session is 09:30–16:00 ET; availability keys on the
# OPEN, so only this matters here (half-day early closes don't move the open).
_SESSION_OPEN_HOUR = 9
_SESSION_OPEN_MINUTE = 30

# US Eastern standard/daylight offsets from UTC (hours). EST = UTC-5, EDT = UTC-4.
_EST_OFFSET_H = -5
_EDT_OFFSET_H = -4

# Juneteenth (Jun 19) became a market holiday only in 2022; no NYSE closure for it before then.
_JUNETEENTH_FIRST_YEAR = 2022

# Ad-hoc, non-rule-based historical NYSE full closures (national mourning / disasters). Empty by
# default (the documented known gap); add dates here if a backtest is found sensitive to one. Kept as a
# hook so the rule engine stays clean and the exceptions are explicit, not buried in the rules.
_AD_HOC_CLOSURES: frozenset[date] = frozenset()


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """The `n`-th `weekday` (Mon=0…Sun=6) of `month`/`year` (n>=1)."""
    d = date(year, month, 1)
    offset = (weekday - d.weekday()) % 7
    return d + timedelta(days=offset + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    """The LAST `weekday` of `month`/`year` (e.g. Memorial Day = last Monday of May)."""
    nxt = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    d = nxt - timedelta(days=1)
    while d.weekday() != weekday:
        d -= timedelta(days=1)
    return d


def _easter_sunday(year: int) -> date:
    """Easter Sunday (Gregorian) via the anonymous computus — Good Friday is 2 days earlier."""
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    ell = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * ell) // 451
    month = (h + ell - 7 * m + 114) // 31
    day = ((h + ell - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _observed_weekend(d: date, *, shift_saturday: bool = True) -> date:
    """Apply the NYSE weekend-observance rule to a fixed-date holiday: a Saturday holiday is observed
    the preceding Friday, a Sunday holiday the following Monday. `shift_saturday=False` for New Year's
    Day, which NYSE does NOT move to Dec 31 when Jan 1 is a Saturday (the only asymmetric case)."""
    if d.weekday() == 5:  # Saturday
        return d - timedelta(days=1) if shift_saturday else d
    if d.weekday() == 6:  # Sunday
        return d + timedelta(days=1)
    return d


@lru_cache(maxsize=64)
def _nyse_full_closures(year: int) -> frozenset[date]:
    """The NYSE full-closure dates for `year`, computed by rule (see module docstring). Cached per year
    (immutable). A Saturday New-Year is the one fixed-date holiday that is NOT shifted to Friday."""
    closures: set[date] = set()
    # Fixed-date with weekend observance. New Year's: no Saturday→Friday shift.
    closures.add(_observed_weekend(date(year, 1, 1), shift_saturday=False))  # New Year's Day
    closures.add(_observed_weekend(date(year, 7, 4)))                        # Independence Day
    closures.add(_observed_weekend(date(year, 12, 25)))                      # Christmas
    # nth-weekday holidays.
    closures.add(_nth_weekday(year, 1, 0, 3))    # MLK Day — 3rd Mon Jan
    closures.add(_nth_weekday(year, 2, 0, 3))    # Presidents Day — 3rd Mon Feb
    closures.add(_last_weekday(year, 5, 0))      # Memorial Day — last Mon May
    closures.add(_nth_weekday(year, 9, 0, 1))    # Labor Day — 1st Mon Sep
    closures.add(_nth_weekday(year, 11, 3, 4))   # Thanksgiving — 4th Thu Nov
    # Good Friday — 2 days before Easter Sunday.
    closures.add(_easter_sunday(year) - timedelta(days=2))
    # Juneteenth — Jun 19 observed, only from 2022.
    if year >= _JUNETEENTH_FIRST_YEAR:
        closures.add(_observed_weekend(date(year, 6, 19)))
    # Ad-hoc historical closures in this year (the documented known-gap hook).
    closures |= {d for d in _AD_HOC_CLOSURES if d.year == year}
    return frozenset(closures)


def _is_edt(dt_utc: datetime) -> bool:
    """Is the given UTC instant within US Eastern Daylight Time?

    EDT runs from the 2nd Sunday of March at 02:00 LOCAL (07:00 UTC under the pre-transition EST
    offset) to the 1st Sunday of November at 02:00 LOCAL (06:00 UTC under the pre-transition EDT
    offset). Compared in UTC against those exact transition instants. (The 2nd-Sun-Mar / 1st-Sun-Nov
    rule is the post-2007 US DST schedule — the era any EDGAR-sourced filing lives in.)"""
    y = dt_utc.year
    dst_start = datetime(y, 3, _nth_weekday(y, 3, 6, 2).day, 7, 0, tzinfo=timezone.utc)
    dst_end = datetime(y, 11, _nth_weekday(y, 11, 6, 1).day, 6, 0, tzinfo=timezone.utc)
    return dst_start <= dt_utc < dst_end


def _et_offset_hours(dt_utc: datetime) -> int:
    """The UTC offset (hours) in force at this UTC instant: -4 (EDT) or -5 (EST)."""
    return _EDT_OFFSET_H if _is_edt(dt_utc) else _EST_OFFSET_H


def _to_et(dt_utc: datetime) -> datetime:
    """A UTC datetime → its naive ET wall-clock datetime (offset applied, tz stripped)."""
    return (dt_utc + timedelta(hours=_et_offset_hours(dt_utc))).replace(tzinfo=None)


def _is_trading_day(d: date) -> bool:
    """A trading day = a weekday that is not a full NYSE closure. (Half-days ARE trading days — they
    open at 09:30; only the close is early.)"""
    if d.weekday() >= 5:  # Sat / Sun
        return False
    return d not in _nyse_full_closures(d.year)


def _session_open_utc_ms(d: date) -> int:
    """The 09:30 ET open of trading day `d`, as a UTC-ms epoch. The ET→UTC offset is resolved at the
    open instant itself (DST is keyed on the actual moment) by a single fixed-point step: assume the
    offset implied by the day's UTC midnight, build the candidate open, re-resolve the offset there and
    rebuild once. One correction suffices — the open is hours from any DST boundary (02:00 local), so
    the offset can never flip a second time between the candidate and the truth."""
    midnight_utc = datetime(d.year, d.month, d.day, 0, 0, tzinfo=timezone.utc)
    offset = _et_offset_hours(midnight_utc)
    open_utc = midnight_utc  # placeholder; overwritten in the loop below
    for _ in range(2):
        open_utc = datetime(
            d.year, d.month, d.day, _SESSION_OPEN_HOUR, _SESSION_OPEN_MINUTE, tzinfo=timezone.utc
        ) - timedelta(hours=offset)
        new_offset = _et_offset_hours(open_utc)
        if new_offset == offset:
            break
        offset = new_offset
    return int(open_utc.timestamp() * 1000)


def next_session_open_ms(accepted_ts_ms: int) -> int:
    """The NYSE next-session-open availability for a filing accepted at `accepted_ts_ms` (UTC ms).

    Returns the UTC-ms epoch of the OPEN of the earliest trading session at or after `accepted_ts_ms`:
      * accepted strictly BEFORE a session's 09:30 ET open on a trading day → THAT day's open;
      * accepted AT/AFTER the open (intraday, after-hours, on a weekend/holiday) → the NEXT trading
        day's open (the after-hours 18:12-ET-Friday → Monday-open case the contract names).
    Pure + deterministic; the ET conversion + rule-based holidays are self-contained (module docstring).
    """
    dt_utc = datetime.fromtimestamp(accepted_ts_ms / 1000, tz=timezone.utc)
    d = _to_et(dt_utc).date()

    # If today is a trading day and the accept is strictly before the open, today's open is the answer.
    if _is_trading_day(d):
        open_ms = _session_open_utc_ms(d)
        if accepted_ts_ms < open_ms:
            return open_ms

    # Otherwise advance to the next trading day's open (after the open today, weekend, or holiday).
    cursor = d + timedelta(days=1)
    # Bound the scan (a closure run never approaches this; the bound just prevents a runaway loop).
    for _ in range(14):
        if _is_trading_day(cursor):
            return _session_open_utc_ms(cursor)
        cursor += timedelta(days=1)
    # Unreachable with weekends alone (never 14 consecutive non-trading days); stamp the cursor's open
    # regardless so the contract still yields a knowledge_ts, never None.
    return _session_open_utc_ms(cursor)
