"""Unit tests for the lake-backed per-form freshness audit (epic Task 9).

No network: every test builds a tmp fixture lake with the harvester's OWN writers (`identity` for
ticker_history/entities, `normalize.write_company_facts` for the per-CIK facts — guaranteeing the on-disk
shape matches the real write path) and audits it. The load-bearing behaviours:

  * the PER-FORM staleness window — a 20-F ANNUAL filer is NOT flagged stale by the 135-day quarterly
    window (the A2 fix; the 400-day annual window applies because it files no recent 10-Q); a 10-Q
    QUARTERLY filer IS stale at 135 days,
  * the NO_EDGAR exclusion — a name that files nothing with the SEC is never counted `missing` and is
    surfaced in the `no_edgar` block instead,
  * `retirable = (missing == 0 and stale == 0)` over the EDGAR-eligible denominator,
  * the universe is an INPUT (`symbols=`), defaulting to the lake's currently-listed tickers,
  * a cold lake → zero coverage, well-formed (not an error).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import identity
import normalize
import freshness

# A fixed "now" so the relative staleness math is deterministic. 2026-06-12 00:00:00 UTC.
NOW = datetime(2026, 6, 12, tzinfo=timezone.utc)
NOW_MS = int(NOW.timestamp() * 1000)


def _days_ago(n: int) -> date:
    return (NOW - timedelta(days=n)).date()


def _fact(*, end: date, filed: date, form: str, fp: str, val: float = 1.0) -> dict:
    """One complete XBRL observation (every nullable=False column populated, so the fail-closed filter
    keeps it). `end` is the period_end (drives staleness), `filed` the SEC filing date (drives cadence),
    `form` the form type (10-K/10-Q/20-F/...)."""
    return {
        "start": "2020-01-01",
        "end": end.isoformat(),
        "val": val,
        "fy": end.year,
        "fp": fp,
        "form": form,
        "accn": f"{form}-{end.isoformat()}-{filed.isoformat()}",
        "filed": filed.isoformat(),
        "frame": None,
    }


def _companyfacts(cik: int, *facts: dict) -> dict:
    return {"cik": cik, "facts": {"us-gaap": {"Revenues": {"units": {"USD": list(facts)}}}}}


def _seed_ticker(lake, cik: int, ticker: str) -> None:
    """Open a currently-listed ticker→CIK range (valid_to=None) in ticker_history.parquet by snapshotting a
    one-name company_tickers map. Accumulates across calls (snapshot_tickers diffs against history)."""
    # snapshot_tickers reads the EXISTING history each call, so build the cumulative live map and re-snapshot
    # — but it keys off the FULL current map, closing names not present. To add names incrementally we read
    # the current open set and union the new one.
    path = lake / "ticker_history.parquet"
    existing = []
    if path.exists():
        import pyarrow.parquet as pq

        existing = [
            (r["ticker"], r["cik"])
            for r in pq.read_table(path).to_pylist()
            if r["valid_to"] is None
        ]
    live = {i: {"ticker": t, "cik_str": c} for i, (t, c) in enumerate(existing)}
    live[len(live)] = {"ticker": ticker, "cik_str": cik}
    identity.snapshot_tickers(lake, live, today=NOW.date())


def _quarterly_filer(lake, cik: int, ticker: str, *, period_days_ago: int) -> None:
    """A 10-Q quarterly filer: a 10-K plus a RECENT 10-Q (so the cadence test sees a recent 10-Q → quarterly
    window). The newest 10-Q period_end is `period_days_ago` old (drives staleness)."""
    _seed_ticker(lake, cik, ticker)
    normalize.write_company_facts(
        lake,
        _companyfacts(
            cik,
            _fact(end=_days_ago(400), filed=_days_ago(360), form="10-K", fp="FY"),
            _fact(end=_days_ago(period_days_ago), filed=_days_ago(period_days_ago - 30), form="10-Q", fp="Q1"),
        ),
        None,
    )


def _annual_filer(lake, cik: int, ticker: str, *, period_days_ago: int) -> None:
    """A 20-F foreign-private-issuer annual filer: a 20-F and NO 10-Q (so the cadence test sees an annual
    form + no recent 10-Q → the 400-day annual window). The newest 20-F period_end is `period_days_ago`
    old. A real such filer also posts 6-K interims, but those carry no XBRL facts here — the point is the
    absence of a 10-Q."""
    _seed_ticker(lake, cik, ticker)
    normalize.write_company_facts(
        lake,
        _companyfacts(
            cik,
            _fact(end=_days_ago(period_days_ago), filed=_days_ago(period_days_ago - 60), form="20-F", fp="FY"),
        ),
        None,
    )


# --------------------------------------------------------------------------- #
# Per-form staleness window — the A2 fix                                       #
# --------------------------------------------------------------------------- #
def test_annual_20f_filer_not_stale_under_quarterly_window(tmp_path) -> None:
    """A 20-F annual filer whose freshest period_end is ~300 days old is NOT stale — the 400-day annual
    window applies (it files no recent 10-Q). The 135-day quarterly window WOULD wrongly flag it."""
    _annual_filer(tmp_path, 1234567, "TSM", period_days_ago=300)
    audit = freshness.freshness_audit(tmp_path, now_ms=NOW_MS, symbols=["TSM"])
    row = next(n for n in audit["names"] if n["symbol"] == "TSM")
    assert row["covered"] is True
    assert row["filing_cadence"] == "annual"
    assert row["stale"] is False  # 300d < 400d annual window
    assert audit["stale"] == 0
    assert audit["retirable"] is True  # covered + not stale


def test_quarterly_10q_filer_stale_at_135_days(tmp_path) -> None:
    """A 10-Q quarterly filer whose freshest period_end is ~140 days old IS stale — past the 135-day
    quarterly window. (A recent 10-Q keeps it on the tighter window even though it also filed a 10-K.)"""
    _quarterly_filer(tmp_path, 320193, "AAPL", period_days_ago=140)
    audit = freshness.freshness_audit(tmp_path, now_ms=NOW_MS, symbols=["AAPL"])
    row = next(n for n in audit["names"] if n["symbol"] == "AAPL")
    assert row["covered"] is True
    assert row["filing_cadence"] == "quarterly"
    assert row["stale"] is True  # 140d > 135d quarterly window
    assert audit["stale"] == 1
    assert audit["retirable"] is False


def test_quarterly_10q_filer_fresh_within_135_days(tmp_path) -> None:
    """A 10-Q filer ~100 days old is fresh — within the 135-day quarterly window."""
    _quarterly_filer(tmp_path, 789019, "MSFT", period_days_ago=100)
    audit = freshness.freshness_audit(tmp_path, now_ms=NOW_MS, symbols=["MSFT"])
    row = next(n for n in audit["names"] if n["symbol"] == "MSFT")
    assert row["filing_cadence"] == "quarterly"
    assert row["stale"] is False
    assert row["staleness_days"] == 100


def test_annual_filer_stale_only_past_400_days(tmp_path) -> None:
    """An annual filer is stale once its freshest period_end exceeds the 400-day annual window."""
    _annual_filer(tmp_path, 7654321, "ASML", period_days_ago=420)
    audit = freshness.freshness_audit(tmp_path, now_ms=NOW_MS, symbols=["ASML"])
    row = next(n for n in audit["names"] if n["symbol"] == "ASML")
    assert row["filing_cadence"] == "annual"
    assert row["stale"] is True  # 420d > 400d


def test_domestic_name_with_recent_10q_keeps_quarterly_window(tmp_path) -> None:
    """A domestic name that files BOTH a 10-K and recent 10-Qs is quarterly cadence (the recent 10-Q keeps
    the tighter window) — NOT annual, even though it has a 10-K on record."""
    # 10-K filed recently AND a recent 10-Q -> the recent 10-Q wins -> quarterly.
    lake = tmp_path
    _seed_ticker(lake, 200406, "JNJ")
    normalize.write_company_facts(
        lake,
        _companyfacts(
            200406,
            _fact(end=_days_ago(150), filed=_days_ago(120), form="10-K", fp="FY"),
            _fact(end=_days_ago(50), filed=_days_ago(20), form="10-Q", fp="Q1"),
        ),
        None,
    )
    row = next(
        n for n in freshness.freshness_audit(lake, now_ms=NOW_MS, symbols=["JNJ"])["names"]
        if n["symbol"] == "JNJ"
    )
    assert row["filing_cadence"] == "quarterly"


# --------------------------------------------------------------------------- #
# NO_EDGAR exclusion                                                           #
# --------------------------------------------------------------------------- #
def test_no_edgar_name_excluded_from_missing(tmp_path) -> None:
    """A NO_EDGAR name (TCEHY) in the universe is NEVER counted `missing` — it is excluded from the
    eligible denominator and surfaced in the `no_edgar` block with its reason."""
    _quarterly_filer(tmp_path, 320193, "AAPL", period_days_ago=50)  # one covered eligible name
    audit = freshness.freshness_audit(tmp_path, now_ms=NOW_MS, symbols=["AAPL", "TCEHY"])
    # Universe (eligible denominator) is just AAPL — TCEHY is excluded.
    assert audit["universe"] == 1
    assert audit["covered"] == 1
    assert audit["missing"] == 0
    # TCEHY appears nowhere in the per-name table (it is not a `missing` row).
    assert all(n["symbol"] != "TCEHY" for n in audit["names"])
    # It is surfaced in the no_edgar block with the reason.
    assert audit["no_edgar_count"] == 1
    assert audit["no_edgar"][0]["symbol"] == "TCEHY"
    assert "unsponsored adr" in audit["no_edgar"][0]["reason"].lower()


def test_no_edgar_name_does_not_block_retirable(tmp_path) -> None:
    """`retirable` is computed over the eligible denominator only — a NO_EDGAR name being uncovered does
    NOT block it (the whole point of the exclusion)."""
    _quarterly_filer(tmp_path, 320193, "AAPL", period_days_ago=50)  # the only eligible name, fresh
    audit = freshness.freshness_audit(tmp_path, now_ms=NOW_MS, symbols=["AAPL", "TCEHY"])
    assert audit["retirable"] is True  # AAPL covered+fresh; TCEHY excluded, not a blocker


# --------------------------------------------------------------------------- #
# retirable / missing / coverage_pct                                           #
# --------------------------------------------------------------------------- #
def test_missing_name_counted_and_blocks_retirable(tmp_path) -> None:
    """A name in the universe with no harvested facts is `covered:false`, counted `missing`, and blocks
    `retirable` (a gap harvesting CLOSES — distinct from a NO_EDGAR name)."""
    _quarterly_filer(tmp_path, 320193, "AAPL", period_days_ago=50)
    # NVDA is in the universe but never harvested.
    audit = freshness.freshness_audit(tmp_path, now_ms=NOW_MS, symbols=["AAPL", "NVDA"])
    assert audit["universe"] == 2
    assert audit["covered"] == 1
    assert audit["missing"] == 1
    assert audit["coverage_pct"] == 50.0
    assert audit["retirable"] is False
    nvda = next(n for n in audit["names"] if n["symbol"] == "NVDA")
    assert nvda["covered"] is False
    assert nvda["stale"] is True
    assert nvda["staleness_days"] is None
    assert nvda["cik"] is None  # never resolved (absent from ticker_history)


def test_retirable_true_only_when_no_missing_and_no_stale(tmp_path) -> None:
    """`retirable` is true ONLY when missing == 0 AND stale == 0 — both a missing and a stale name break
    it."""
    # Two fresh covered names -> retirable.
    _quarterly_filer(tmp_path, 320193, "AAPL", period_days_ago=40)
    _quarterly_filer(tmp_path, 789019, "MSFT", period_days_ago=40)
    audit = freshness.freshness_audit(tmp_path, now_ms=NOW_MS, symbols=["AAPL", "MSFT"])
    assert audit["missing"] == 0 and audit["stale"] == 0
    assert audit["retirable"] is True

    # Add one stale name -> retirable flips false even with no missing.
    _quarterly_filer(tmp_path, 1045810, "NVDA", period_days_ago=200)  # 200d > 135d -> stale
    audit2 = freshness.freshness_audit(tmp_path, now_ms=NOW_MS, symbols=["AAPL", "MSFT", "NVDA"])
    assert audit2["missing"] == 0
    assert audit2["stale"] == 1
    assert audit2["retirable"] is False


# --------------------------------------------------------------------------- #
# Universe-as-input + default                                                  #
# --------------------------------------------------------------------------- #
def test_default_universe_is_lake_currently_listed_tickers(tmp_path) -> None:
    """When `symbols` is None, the audit defaults to every currently-listed bare ticker in the lake's
    ticker_history (the decoupling default — no Mongo read)."""
    _quarterly_filer(tmp_path, 320193, "AAPL", period_days_ago=40)
    _annual_filer(tmp_path, 1234567, "TSM", period_days_ago=300)
    audit = freshness.freshness_audit(tmp_path, now_ms=NOW_MS, symbols=None)
    symbols = {n["symbol"] for n in audit["names"]}
    assert symbols == {"AAPL", "TSM"}
    assert audit["universe"] == 2


def test_lake_universe_excludes_delisted_open_ranges(tmp_path) -> None:
    """`lake_universe` returns only currently-listed tickers (open validity range). A symbol whose range
    was closed (a rename/delisting) is not in the default audit set."""
    # FB renamed to META: open the FB range then close it (snapshot without FB) and open META.
    identity.snapshot_tickers(tmp_path, {0: {"ticker": "FB", "cik_str": 1326801}}, today=_days_ago(400))
    identity.snapshot_tickers(tmp_path, {0: {"ticker": "META", "cik_str": 1326801}}, today=NOW.date())
    listed = freshness.lake_universe(tmp_path)
    assert "META" in listed
    assert "FB" not in listed  # closed range -> not currently listed


def test_symbol_case_insensitive_in_universe(tmp_path) -> None:
    """Supplied symbols are normalised to bare uppercase before the audit (so `aapl` matches the lake's
    `AAPL` ticker_history row)."""
    _quarterly_filer(tmp_path, 320193, "AAPL", period_days_ago=40)
    audit = freshness.freshness_audit(tmp_path, now_ms=NOW_MS, symbols=["aapl"])
    row = next(n for n in audit["names"] if n["symbol"] == "AAPL")
    assert row["covered"] is True


# --------------------------------------------------------------------------- #
# Cold lake + window helpers                                                   #
# --------------------------------------------------------------------------- #
def test_cold_lake_zero_coverage_well_formed(tmp_path) -> None:
    """A cold lake (nothing harvested) yields a well-formed audit — every eligible name uncovered, zero
    coverage, not an error."""
    audit = freshness.freshness_audit(tmp_path, now_ms=NOW_MS, symbols=["AAPL", "MSFT"])
    assert audit["universe"] == 2
    assert audit["covered"] == 0
    assert audit["missing"] == 2
    assert audit["coverage_pct"] == 0.0
    assert audit["retirable"] is False
    assert all(n["covered"] is False for n in audit["names"])


def test_cold_lake_empty_default_universe(tmp_path) -> None:
    """A cold lake with the default (lake) universe → an empty, well-formed audit (no ticker_history)."""
    audit = freshness.freshness_audit(tmp_path, now_ms=NOW_MS, symbols=None)
    assert audit["universe"] == 0
    assert audit["names"] == []
    assert audit["coverage_pct"] == 0.0
    # retirable over an empty eligible set is vacuously true (missing == 0 and stale == 0).
    assert audit["retirable"] is True


def test_stale_after_ms_helpers_default_and_floor() -> None:
    """The window helpers: None/non-positive → the 135/400-day defaults; the annual window is floored at
    the quarterly one inside the audit."""
    assert freshness.stale_after_ms_from_days(None) == 135 * freshness._MS_PER_DAY
    assert freshness.stale_after_ms_from_days(0) == 135 * freshness._MS_PER_DAY
    assert freshness.stale_after_ms_from_days(200) == 200 * freshness._MS_PER_DAY
    assert freshness.annual_stale_after_ms_from_days(None) == 400 * freshness._MS_PER_DAY
    assert freshness.annual_stale_after_ms_from_days(0) == 400 * freshness._MS_PER_DAY


def test_annual_window_floored_at_quarterly(tmp_path) -> None:
    """An inconsistent override (annual < quarterly) is floored: the annual window is never tighter than the
    quarterly one, so an annual filer is never treated as MORE time-sensitive than a quarterly one."""
    _annual_filer(tmp_path, 1234567, "TSM", period_days_ago=300)
    # annual window 100d < quarterly 135d -> floored to 135d -> 300d still stale (the floor doesn't make it
    # fresh), proving the floor applied (without it, 300d > 100d would also be stale, so assert via a case
    # where the floor matters): set quarterly 350d, annual 100d -> floored to 350d -> 300d NOT stale.
    audit = freshness.freshness_audit(
        tmp_path,
        now_ms=NOW_MS,
        symbols=["TSM"],
        stale_after_ms=350 * freshness._MS_PER_DAY,
        annual_stale_after_ms=100 * freshness._MS_PER_DAY,
    )
    row = next(n for n in audit["names"] if n["symbol"] == "TSM")
    # annual floored up to 350d -> 300d < 350d -> NOT stale (would be stale if the raw 100d annual applied).
    assert row["stale"] is False
