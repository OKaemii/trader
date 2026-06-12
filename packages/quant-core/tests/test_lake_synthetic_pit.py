"""Offline end-to-end PIT correctness proof for the fundamentals lake (epic Task 7).

This is the epic's NO-NETWORK regression guard: it fabricates a synthetic per-CIK lake (a
restatement + a ticker rename, no EDGAR fetch) and asserts the whole point-in-time read path is
correct over the REAL lake stack now on master —
``quant_core.fundamentals.lake.{schema,calendar,store,metrics,contract}`` + the canonical
``quant_core.ticker_identity``. It ports the prototype ``scripts/demo_synthetic.py`` assertions onto
those real modules; where the prototype keyed its PIT axis on the SEC ``filed`` date, the real store
keys on the DERIVED ``knowledge_ts`` (next-NYSE-session-open availability), so every synthetic fact's
``knowledge_ts`` here is computed by the real ``calendar.derive_knowledge_ts`` from an EDGAR-style
``acceptanceDateTime`` — the after-hours / weekend look-ahead derivation is part of what is proved, not
stubbed past.

The single company (CIK 999, renamed ``OLDT``→``ACME`` on 2023-06-01, a la FB→META):

  * files Q1–Q3 2023 (10-Q) then a FY2023 10-K with Revenues = 400;
  * later RESTATES FY2023 Revenues to 402 in a 10-K/A;
  * carries an Assets = 1500 instant + the full balance-sheet/cover-page leg set so the byte-compatible
    contract resolves a covered name.
A second independent CIK (1234) exists so a per-CIK read never fans into another name.

The four behaviours the whole guarantee rests on, asserted end-to-end (no read-engine mocks):

  1. **Restatement supersede.** An as-of read BEFORE the amendment's ``knowledge_ts`` returns the
     FIRST-print 400; an as-of read AFTER returns the restated 402 — and the derived Q4 + TTM shift
     with it. Nothing is overwritten (the 10-K/A is just another row with a later ``knowledge_ts``; the
     store's ``row_number() OVER (… ORDER BY knowledge_ts DESC)`` does the superseding at read time).
  2. **Rename PIT.** ``resolve('OLDT', 'US', 2022)`` (the old symbol in its era) and
     ``resolve('ACME', 'US', today)`` (the new symbol now) land on the SAME CIK / one continuous
     history; asking for the retired symbol TODAY falls forward to the same CIK (the ``FB`` now case).
  3. **``knowledge_ts`` cutoff (look-ahead guard, incl. the after-hours derivation).** A fact whose
     derived ``knowledge_ts`` is after the as_of is INVISIBLE. The 10-K is ACCEPTED after the close on a
     Thursday, so it is not knowable until the next session's open — an as-of on the acceptance day
     itself sees NOTHING, and the per-fact derivation is proved against the real
     ``next_session_open_ms`` (no same-day knowability for an after-hours accept).
  4. **Fail-closed contract.** ``pit_line_items`` for the covered US CIK yields the expected
     canonical-spelled legs (every key a real ``LINE_ITEMS`` member); a leg with no fact is OMITTED (not
     0); a non-US identity → ``{}``.

pyarrow + duckdb are the ``quant-core[lake]`` extra — the docker gate installs ``[lake]`` and
auto-collects ``packages/quant-core/tests/``, so this suite runs in the PR gate by construction;
locally it ``importorskip``s both so the rest of the quant-core suite still collects where they are
absent. The synthetic lake is written in the EXACT on-disk shapes the harvester produces: per-CIK facts
via the Task-3 ``SCHEMA`` plus ``ticker_history.parquet`` (cik, ticker, valid_from, valid_to) and
``entities.parquet`` (cik, name, sic, sic_desc, exchanges, tickers, former_names) — the fixture style
shared with ``test_lake_store.py`` / ``test_lake_contract.py``.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")
pytest.importorskip("duckdb")

from quant_core.fundamentals.contract import LINE_ITEMS, SOURCE_PIT_EDGAR  # noqa: E402
from quant_core.fundamentals.lake.calendar import (  # noqa: E402
    derive_knowledge_ts,
    next_session_open_ms,
)
from quant_core.fundamentals.lake.contract import pit_line_items  # noqa: E402
from quant_core.fundamentals.lake.metrics import metric_series  # noqa: E402
from quant_core.fundamentals.lake.schema import SCHEMA  # noqa: E402
from quant_core.fundamentals.lake.store import Store  # noqa: E402
from quant_core.ticker_identity import TickerIdentity  # noqa: E402

# Identity-table schemas mirror the harvester's writers (identity.py); the store reads these columns by
# name. Kept local so the synthetic lake is the EXACT on-disk shape — same as the Task-5/6 suites.
_TICKER_SCHEMA = pa.schema(
    [
        ("cik", pa.int32()),
        ("ticker", pa.string()),
        ("valid_from", pa.date32()),
        ("valid_to", pa.date32()),  # null = currently listed under this symbol
    ]
)
_ENTITY_SCHEMA = pa.schema(
    [
        ("cik", pa.int32()),
        ("name", pa.string()),
        ("sic", pa.string()),
        ("sic_desc", pa.string()),
        ("exchanges", pa.string()),     # JSON list
        ("tickers", pa.string()),       # JSON list
        ("former_names", pa.string()),  # JSON list of {name, from, to}
    ]
)

CIK_ACME = 999      # files + restates FY revenue; renamed OLDT -> ACME on 2023-06-01
CIK_OTHER = 1234    # an independent name (proves per-CIK file targeting isolates reads)

RENAME_DATE = date(2023, 6, 1)
TODAY = date(2026, 6, 12)


def _utc_ms(y: int, mo: int, d: int, h: int, mi: int) -> int:
    """A UTC wall-clock instant as a UTC-ms epoch — the unit EDGAR ``acceptanceDateTime`` and the
    lake's ``accepted_ts`` / ``knowledge_ts`` columns use."""
    return int(datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp() * 1000)


# EDGAR acceptance instants (genuine UTC) for each filing, chosen so the derived next-session-open
# availability is non-trivial — they are run through the REAL `derive_knowledge_ts` below so the proof
# exercises the harvester's actual availability rule, not a hand-picked knowledge_ts.
#
# 2024-02-15 is a Thursday; an accept at 23:00 UTC (18:00 ET, AFTER the 16:00 ET close) is not knowable
# until Friday 2024-02-16's 09:30 ET open — so an as-of on the acceptance day sees nothing (assertion 3).
ACCEPT_10K = _utc_ms(2024, 2, 15, 23, 0)     # Thu after-hours -> knowable Fri 2024-02-16 open
ACCEPT_10KA = _utc_ms(2024, 8, 9, 14, 0)     # 2024-08-09 Fri 10:00 ET (intraday) -> Mon 2024-08-12 open
# The three 2023 quarters (10-Q), each accepted mid-morning ET on a trading day. The exact instants are
# immaterial to the quarter assertions (all comfortably < the FY as-of); they exist so derived-Q4/TTM
# have real inputs with their own derived availability.
ACCEPT_Q1 = _utc_ms(2023, 5, 1, 14, 0)
ACCEPT_Q2 = _utc_ms(2023, 8, 1, 14, 0)
ACCEPT_Q3 = _utc_ms(2023, 11, 1, 14, 0)

# The DERIVED knowledge instants (computed by the real calendar, NOT hand-set) — the read axis. Named
# here so the assertions reference the same derivation the store filters on.
KTS_10K = derive_knowledge_ts(ACCEPT_10K, date(2024, 2, 15))     # Fri 2024-02-16 open
KTS_10KA = derive_knowledge_ts(ACCEPT_10KA, date(2024, 8, 9))    # Mon 2024-08-12 open


def _fact(
    *,
    cik: int,
    concept: str,
    value: float,
    end: str,
    accepted_ts: int,
    filed: str,
    accession: str,
    form: str,
    start: str | None = None,
    taxonomy: str = "us-gaap",
    unit: str = "USD",
    fy: int = 2023,
    fp: str = "FY",
) -> dict:
    """One fact row in the Task-3 ``SCHEMA`` shape. ``knowledge_ts`` is DERIVED from ``accepted_ts`` via
    the real ``derive_knowledge_ts`` (the harvester's sweep-path rule) — so the synthetic lake carries
    the same availability axis the production write path would, and the look-ahead guard is proved
    against the real next-session-open derivation rather than a fabricated instant."""
    return {
        "cik": cik,
        "taxonomy": taxonomy,
        "concept": concept,
        "unit": unit,
        "start": date.fromisoformat(start) if start else None,
        "end": date.fromisoformat(end),
        "value": float(value),
        "fy": fy,
        "fp": fp,
        "form": form,
        "accession": accession,
        "filed": date.fromisoformat(filed),
        "accepted_ts": accepted_ts,
        "knowledge_ts": derive_knowledge_ts(accepted_ts, date.fromisoformat(filed)),
        "frame": None,
    }


def _quarter(cik: int, concept: str, start: str, end: str, value: float, accepted_ts: int,
             filed: str, fp: str) -> dict:
    return _fact(cik=cik, concept=concept, value=value, start=start, end=end,
                 accepted_ts=accepted_ts, filed=filed, accession=f"{concept[:3]}-{fp}",
                 form="10-Q", fp=fp)


def _annual(cik: int, concept: str, fy: int, value: float, accepted_ts: int, filed: str,
            accession: str, form: str = "10-K") -> dict:
    return _fact(cik=cik, concept=concept, value=value, start=f"{fy}-01-01", end=f"{fy}-12-31",
                 accepted_ts=accepted_ts, filed=filed, accession=accession, form=form, fy=fy, fp="FY")


def _instant(cik: int, concept: str, end: str, value: float, accepted_ts: int, filed: str,
             *, taxonomy: str = "us-gaap", unit: str = "USD") -> dict:
    return _fact(cik=cik, concept=concept, value=value, start=None, end=end, accepted_ts=accepted_ts,
                 filed=filed, accession=f"{concept[:3]}-inst", form="10-K", taxonomy=taxonomy, unit=unit)


def _write_facts(lake: Path, cik: int, rows: list[dict]) -> None:
    out = lake / "facts"
    out.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows, schema=SCHEMA),
                   out / f"cik={int(cik):010d}.parquet", compression="zstd")


def _write_ticker_history(lake: Path, rows: list[dict]) -> None:
    pq.write_table(pa.Table.from_pylist(rows, schema=_TICKER_SCHEMA),
                   lake / "ticker_history.parquet", compression="zstd")


def _write_entities(lake: Path, rows: list[dict]) -> None:
    pq.write_table(pa.Table.from_pylist(rows, schema=_ENTITY_SCHEMA),
                   lake / "entities.parquet", compression="zstd")


@pytest.fixture()
def lake(tmp_path: Path) -> Path:
    """The synthetic lake the prototype's demo builds, on the real Task-3 ``SCHEMA``.

    CIK_ACME (OLDT→ACME on 2023-06-01):
      * Revenues: Q1=90, Q2=100, Q3=105 (10-Q), FY2023=400 (10-K) first print, then FY2023=402
        (10-K/A) restatement — same fiscal period, LATER derived knowledge_ts.
      * a full balance-sheet/cover-page instant set at 2023-12-31 (so the contract resolves a covered
        name): Assets, Liabilities, StockholdersEquity, AssetsCurrent, LiabilitiesCurrent, LongTermDebt,
        plus the dei cover-page share count — all knowable at the 10-K instant.
      * net income annuals FY21/22/23 (so ``earnings_stability`` is defined: ≥3 points).
    CIK_OTHER: a single independent FY2023 Revenues=777.
    """
    root = tmp_path / "lake"
    root.mkdir()

    rev_quarters = [
        _quarter(CIK_ACME, "Revenues", "2023-01-01", "2023-03-31", 90, ACCEPT_Q1, "2023-05-01", "Q1"),
        _quarter(CIK_ACME, "Revenues", "2023-04-01", "2023-06-30", 100, ACCEPT_Q2, "2023-08-01", "Q2"),
        _quarter(CIK_ACME, "Revenues", "2023-07-01", "2023-09-30", 105, ACCEPT_Q3, "2023-11-01", "Q3"),
    ]
    rev_annuals = [
        # first print (10-K) then restatement (10-K/A) of the SAME period, later acceptance/knowledge_ts
        _annual(CIK_ACME, "Revenues", 2023, 400, ACCEPT_10K, "2024-02-15", "A4", form="10-K"),
        _annual(CIK_ACME, "Revenues", 2023, 402, ACCEPT_10KA, "2024-08-09", "A5", form="10-K/A"),
    ]
    # net income annuals FY21/22/23 for earnings_stability (each its own prior-year 10-K acceptance)
    ni_annuals = [
        _annual(CIK_ACME, "NetIncomeLoss", 2021, 90, _utc_ms(2022, 2, 15, 23, 0), "2022-02-15", "NI21"),
        _annual(CIK_ACME, "NetIncomeLoss", 2022, 100, _utc_ms(2023, 2, 15, 23, 0), "2023-02-15", "NI22"),
        _annual(CIK_ACME, "NetIncomeLoss", 2023, 110, ACCEPT_10K, "2024-02-15", "NI23"),
    ]
    # the other flows (one FY2023 annual each) so the covered-name contract has all 4 flow legs
    other_flows = [
        _annual(CIK_ACME, "GrossProfit", 2023, 160, ACCEPT_10K, "2024-02-15", "GP23"),
        _annual(CIK_ACME, "NetCashProvidedByUsedInOperatingActivities", 2023, 150, ACCEPT_10K,
                "2024-02-15", "CF23"),
    ]
    instants = [
        _instant(CIK_ACME, "Assets", "2023-12-31", 1500, ACCEPT_10K, "2024-02-15"),
        _instant(CIK_ACME, "Liabilities", "2023-12-31", 1000, ACCEPT_10K, "2024-02-15"),
        _instant(CIK_ACME, "StockholdersEquity", "2023-12-31", 500, ACCEPT_10K, "2024-02-15"),
        _instant(CIK_ACME, "AssetsCurrent", "2023-12-31", 600, ACCEPT_10K, "2024-02-15"),
        _instant(CIK_ACME, "LiabilitiesCurrent", "2023-12-31", 300, ACCEPT_10K, "2024-02-15"),
        _instant(CIK_ACME, "LongTermDebt", "2023-12-31", 250, ACCEPT_10K, "2024-02-15"),
        _instant(CIK_ACME, "EntityCommonStockSharesOutstanding", "2023-12-31", 50, ACCEPT_10K,
                 "2024-02-15", taxonomy="dei", unit="shares"),
    ]
    _write_facts(root, CIK_ACME,
                 rev_quarters + rev_annuals + ni_annuals + other_flows + instants)
    _write_facts(root, CIK_OTHER, [
        _annual(CIK_OTHER, "Revenues", 2023, 777, _utc_ms(2024, 2, 20, 23, 0), "2024-02-20", "B1"),
    ])
    _write_ticker_history(root, [
        # OLDT listed 2020-01-01 .. 2023-06-01, then renamed ACME (still live). Same CIK throughout.
        {"cik": CIK_ACME, "ticker": "OLDT", "valid_from": date(2020, 1, 1), "valid_to": RENAME_DATE},
        {"cik": CIK_ACME, "ticker": "ACME", "valid_from": RENAME_DATE, "valid_to": None},
        {"cik": CIK_OTHER, "ticker": "OTHR", "valid_from": date(2019, 1, 1), "valid_to": None},
    ])
    _write_entities(root, [
        {"cik": CIK_ACME, "name": "Acme Corp", "sic": "7372", "sic_desc": "Prepackaged Software",
         "exchanges": json.dumps(["NYSE"]), "tickers": json.dumps(["ACME"]),
         "former_names": json.dumps([{"name": "OldCo", "from": "2020-01-01", "to": "2023-06-01"}])},
        {"cik": CIK_OTHER, "name": "Other Inc", "sic": "1234", "sic_desc": "Things",
         "exchanges": json.dumps(["NASDAQ"]), "tickers": json.dumps(["OTHR"]),
         "former_names": json.dumps([])},
    ])
    return root


# --------------------------------------------------------------------------------------------------- #
# 1. Restatement supersede — first print before the amendment, restated value after                   #
# --------------------------------------------------------------------------------------------------- #
def _annual_revenue(store: Store, as_of: date) -> dict:
    """The latest annual Revenues point as of a date (the prototype's ``annual`` helper, real API)."""
    return metric_series(store, CIK_ACME, "total_revenue", "a", as_of)["points"][-1]


def test_restatement_first_print_before_amendment(lake: Path) -> None:
    """As of 2024-03-01 (after the 10-K is knowable, before the 10-K/A) the FY2023 revenue is the
    FIRST-print 400, sourced from the 10-K — the restatement's knowledge_ts is still in the future."""
    s = Store(lake)
    before = _annual_revenue(s, date(2024, 3, 1))
    assert before["value"] == 400.0
    assert before["form"] == "10-K"
    assert before["accession"] == "A4"


def test_restatement_restated_value_after_amendment(lake: Path) -> None:
    """As of 2025-01-01 (after the 10-K/A is knowable) the FY2023 revenue is the RESTATED 402, sourced
    from the 10-K/A — the later knowledge_ts wins at read time; the first print was not overwritten
    (an as-of at the original date still returns 400, per the test above)."""
    s = Store(lake)
    after = _annual_revenue(s, date(2025, 1, 1))
    assert after["value"] == 402.0
    assert after["form"] == "10-K/A"
    assert after["accession"] == "A5"


def test_derived_q4_shifts_with_the_restatement(lake: Path) -> None:
    """The derived Q4 (= FY − (Q1+Q2+Q3)) tracks the as-of FY value: 400 − 295 = 105 before the
    amendment, 402 − 295 = 107 after. The derived row is flagged ``derived=True`` and PIT-safe (its
    knowledge_ts is the max of its inputs', so it never surfaces before every input was public)."""
    s = Store(lake)

    def q4(as_of: date) -> tuple[float, bool]:
        pts = {p["end"]: (p["value"], p["derived"])
               for p in metric_series(s, CIK_ACME, "total_revenue", "q", as_of)["points"]}
        return pts[date(2023, 12, 31)]

    assert q4(date(2024, 3, 1)) == (105.0, True)   # 400 − (90+100+105)
    assert q4(date(2025, 1, 1)) == (107.0, True)   # 402 − (90+100+105)


def test_ttm_stitches_derived_q4_with_real_quarters(lake: Path) -> None:
    """The TTM through 2023-12-31 sums the three real quarters + the derived Q4 and equals the as-of FY
    (the four quarters reconstruct the year). After the restatement it is 402 (derived=True)."""
    s = Store(lake)
    ttm = metric_series(s, CIK_ACME, "total_revenue", "ttm", date(2025, 1, 1))["points"][-1]
    assert ttm["value"] == 402.0
    assert ttm["end"] == date(2023, 12, 31)
    assert ttm["derived"] is True


def test_instant_assets_resolves_at_its_period_end(lake: Path) -> None:
    """The Assets=1500 instant (no ``start``) resolves at 2023-12-31 — instants partition on ``end``
    alone and PIT-filter the same way as duration facts."""
    s = Store(lake)
    pts = metric_series(s, CIK_ACME, "total_assets", "q", date(2025, 1, 1))["points"]
    assert pts[-1]["value"] == 1500.0
    assert pts[-1]["start"] is None
    assert pts[-1]["end"] == date(2023, 12, 31)


# --------------------------------------------------------------------------------------------------- #
# 2. Rename PIT — old symbol in its era and new symbol today land on the same CIK                      #
# --------------------------------------------------------------------------------------------------- #
def test_rename_old_and_new_symbol_resolve_to_one_cik(lake: Path) -> None:
    """``OLDT`` in its era (2022) and ``ACME`` today both resolve to CIK 999 — history is continuous
    across the rename (FB@2021 and META@today → one CIK, the canonical case)."""
    s = Store(lake)
    old = s.resolve("OLDT", "US", date(2022, 5, 1))
    new = s.resolve("ACME", "US", TODAY)
    assert old is not None and new is not None
    assert old["cik"] == new["cik"] == CIK_ACME


def test_retired_symbol_today_falls_forward_to_same_cik(lake: Path) -> None:
    """Asking for the RETIRED symbol TODAY (its window closed at the rename) falls forward to its
    successor's CIK rather than dead-ending — exactly ``FB`` queried now → META's CIK."""
    s = Store(lake)
    legacy_today = s.resolve("OLDT", "US", TODAY)
    assert legacy_today is not None
    assert legacy_today["cik"] == CIK_ACME


def test_rename_history_is_continuous_across_the_rename(lake: Path) -> None:
    """The SAME FY2023 fact is reachable whether resolved via the old or the new symbol — the CIK is
    stable, so the metric series does not break at the rename boundary. (Resolve both symbols, then read
    the metric off the shared CIK to prove one continuous history.)"""
    s = Store(lake)
    via_old = s.resolve("OLDT", "US", date(2022, 5, 1))["cik"]
    via_new = s.resolve("ACME", "US", TODAY)["cik"]
    assert via_old == via_new
    rev = metric_series(s, via_new, "total_revenue", "a", TODAY)["points"][-1]["value"]
    assert rev == 402.0  # the latest-known FY2023, reached through the post-rename symbol's CIK


# --------------------------------------------------------------------------------------------------- #
# 3. knowledge_ts cutoff (look-ahead guard) — including the after-hours/next-session derivation        #
# --------------------------------------------------------------------------------------------------- #
# The raw `pit_series` for Revenues returns ONE row per fiscal period (PARTITION BY (start, end)) — the
# three 2023 quarters AND the FY2023 annual. The restatement supersedes only the FY2023 ANNUAL period
# (2023-01-01 .. 2023-12-31), so the knowledge_ts-cutoff assertions target that period's row.
_FY2023 = (date(2023, 1, 1), date(2023, 12, 31))


def _fy2023_annual_value(rows: list[dict]) -> float | None:
    """The value of the FY2023 annual period row in a raw Revenues `pit_series`, or None if that period
    is not yet knowable (the quarters may still be present at an earlier cutoff)."""
    fy = [r for r in rows if (r["start"], r["end"]) == _FY2023]
    assert len(fy) <= 1, "the FY2023 period must resolve to a single latest-known row"
    return fy[0]["value"] if fy else None


def test_after_hours_filing_not_knowable_same_day(lake: Path) -> None:
    """The 10-K is ACCEPTED 2024-02-15 (Thu) 23:00 UTC = 18:00 ET, AFTER the 16:00 ET close, so it is
    NOT knowable that calendar day — an as-of on the acceptance day sees no FY2023 annual at all. This
    is the after-hours look-ahead guard the PIT contract exists for, proved over the real
    ``derive_knowledge_ts`` (no fact predates 2024-02-15, so the series is empty)."""
    s = Store(lake)
    same_day = metric_series(s, CIK_ACME, "total_revenue", "a", date(2024, 2, 15))["points"]
    assert same_day == []  # the 10-K accepted after close is not knowable on its acceptance day


def test_after_hours_filing_knowable_next_session_open(lake: Path) -> None:
    """The same 10-K IS knowable the next session — 2024-02-16 (Fri) — at/after its derived
    knowledge_ts (Fri 09:30 ET open). The derivation is the real ``next_session_open_ms`` of the
    acceptance instant; pin it so the synthetic axis matches production exactly."""
    s = Store(lake)
    assert KTS_10K == next_session_open_ms(ACCEPT_10K)
    # the derived availability is 2024-02-16 (the trading day AFTER the Thursday after-hours accept)
    assert datetime.fromtimestamp(KTS_10K / 1000, tz=timezone.utc).date() == date(2024, 2, 16)
    # a read AT the derived knowledge instant: the FY2023 annual period is now the first print (400)
    at_open = s.pit_series(CIK_ACME, "us-gaap", "Revenues", "USD", KTS_10K, instant=False)
    assert _fy2023_annual_value(at_open) == 400.0
    # one millisecond before, the FY2023 annual is NOT yet knowable (the cutoff is exclusive); the
    # quarters that were filed earlier stay visible, but no FY-period row appears.
    before_open = s.pit_series(CIK_ACME, "us-gaap", "Revenues", "USD", KTS_10K - 1, instant=False)
    assert _fy2023_annual_value(before_open) is None


def test_mid_year_as_of_knows_only_filed_quarters(lake: Path) -> None:
    """As of 2023-09-01 only Q1 + Q2 are knowable (Q3 is accepted 2023-11-01, the FY 10-K 2024-02) —
    no derived Q4 (its FY input is in the future), so exactly two quarters and no 2023-12-31 point."""
    s = Store(lake)
    pts = {p["end"] for p in metric_series(s, CIK_ACME, "total_revenue", "q", date(2023, 9, 1))["points"]}
    assert pts == {date(2023, 3, 31), date(2023, 6, 30)}
    assert date(2023, 12, 31) not in pts


def test_restatement_invisible_until_its_own_knowledge_ts(lake: Path) -> None:
    """The 10-K/A restatement (accepted 2024-08-09 intraday → knowable Mon 2024-08-12 open) is INVISIBLE
    one millisecond before its derived knowledge_ts and visible at it — the supersede happens exactly at
    the amendment's availability, not its filing/acceptance instant."""
    s = Store(lake)
    assert KTS_10KA == next_session_open_ms(ACCEPT_10KA)
    assert datetime.fromtimestamp(KTS_10KA / 1000, tz=timezone.utc).date() == date(2024, 8, 12)
    # one ms before the amendment is knowable, the FY2023 annual is still the first print (400)
    just_before = s.pit_series(CIK_ACME, "us-gaap", "Revenues", "USD", KTS_10KA - 1, instant=False)
    assert _fy2023_annual_value(just_before) == 400.0
    # exactly at the amendment's availability, the FY2023 annual flips to the restated 402
    at_kts = s.pit_series(CIK_ACME, "us-gaap", "Revenues", "USD", KTS_10KA, instant=False)
    assert _fy2023_annual_value(at_kts) == 402.0
    # the FY period still resolves to a SINGLE row — the restatement supersedes, never appends
    fy_rows = [r for r in at_kts if (r["start"], r["end"]) == _FY2023]
    assert len(fy_rows) == 1 and fy_rows[0]["form"] == "10-K/A"


def test_per_cik_read_does_not_leak_another_name(lake: Path) -> None:
    """A read of CIK_ACME never returns CIK_OTHER's Revenues=777 — the hot path targets the single
    per-CIK file, so there is no cross-CIK fan-out."""
    s = Store(lake)
    acme = s.pit_series(CIK_ACME, "us-gaap", "Revenues", "USD", KTS_10KA, instant=False)
    other = s.pit_series(CIK_OTHER, "us-gaap", "Revenues", "USD", KTS_10KA, instant=False)
    # ACME's read is its own quarters + the (restated) FY2023 annual — CIK_OTHER's 777 never leaks in.
    assert _fy2023_annual_value(acme) == 402.0
    assert 777.0 not in {r["value"] for r in acme}
    # the other CIK's read is only its single FY2023 row
    assert [r["value"] for r in other] == [777.0]


# --------------------------------------------------------------------------------------------------- #
# 4. Fail-closed contract — covered US legs (canonical), omitted leg, non-US → {}                      #
# --------------------------------------------------------------------------------------------------- #
def test_contract_covered_us_name_yields_canonical_legs(lake: Path) -> None:
    """``pit_line_items`` for the covered US CIK (resolved via the post-rename symbol ACME) yields the
    full leg set with CANONICAL ``LINE_ITEMS`` spellings, sourced ``pit-edgar``. The flows resolve via
    TTM-or-annual (net_income/total_revenue/gross_profit/cash_flow_ops), the 7 instants at 2023-12-31,
    plus ``earnings_stability`` from the 3 net-income annuals — exactly the 12 raw legs the contract
    assembles (``market_cap_gbp`` / ``dividend_yield`` are the API's enrichment, never produced here)."""
    s = Store(lake)
    as_of = _utc_ms(2025, 1, 1, 14, 30)  # after the 10-K/A is knowable
    li, source, obs, kts = pit_line_items(s, TickerIdentity("ACME", "US"), as_of)
    expected = {
        "net_income", "total_revenue", "gross_profit", "cash_flow_ops",
        "total_equity", "total_assets", "total_liabilities", "current_assets",
        "current_liabilities", "total_debt", "shares_outstanding", "earnings_stability",
    }
    assert set(li) == expected
    assert set(li) <= set(LINE_ITEMS)        # every key a real contract member (canonical snake_case)
    assert "market_cap_gbp" not in li        # the enriched legs are the API's job, not the contract's
    assert "dividend_yield" not in li
    # the restated FY2023 revenue flows through to the contract (TTM stitches the quarters → 402)
    assert li["total_revenue"] == 402.0
    assert li["net_income"] == 110.0
    assert li["total_debt"] == 250.0         # LongTermDebt, the select-fallback
    assert li["shares_outstanding"] == 50.0
    assert source == SOURCE_PIT_EDGAR
    assert obs is not None and kts is not None


def test_contract_missing_leg_is_omitted_not_zero(tmp_path: Path) -> None:
    """A covered US name whose filings LACK a leg (here gross_profit) returns a dict WITHOUT that key —
    ``key not in dict``, never ``dict[key] == 0``. A fabricated 0 would corrupt any ratio reading it;
    the factor NaN-excludes a missing key instead. (Built as a minimal name so the omission is the only
    variable — net_income present so the name resolves, GrossProfit absent.)"""
    root = tmp_path / "partial"
    root.mkdir()
    _write_facts(root, 500, [
        _annual(500, "NetIncomeLoss", 2023, 110, ACCEPT_10K, "2024-02-15", "NI23"),
        _instant(500, "StockholdersEquity", "2023-12-31", 500, ACCEPT_10K, "2024-02-15"),
    ])
    _write_ticker_history(root, [
        {"cik": 500, "ticker": "PART", "valid_from": date(2015, 1, 1), "valid_to": None},
    ])
    s = Store(root)
    li, source, _, _ = pit_line_items(s, TickerIdentity("PART", "US"), _utc_ms(2025, 1, 1, 14, 30))
    assert "gross_profit" not in li           # absent...
    assert li.get("gross_profit") is None     # ...so .get is None, never 0
    assert li["net_income"] == 110.0          # the legs it DOES have still resolve
    assert source == SOURCE_PIT_EDGAR


def test_contract_non_us_identity_is_fail_closed_empty(lake: Path) -> None:
    """A non-US (LSE) identity returns ``({}, None, None, None)`` immediately — no EDGAR presence and,
    per Thread C, NO Yahoo fallback. The covered ACME facts exist in the lake, but the LSE market routes
    past them; the legs are NaN-excluded downstream."""
    s = Store(lake)
    assert pit_line_items(s, TickerIdentity("ACME", "LSE"), _utc_ms(2025, 1, 1, 14, 30)) == (
        {}, None, None, None)


def test_contract_before_anything_knowable_is_a_miss(lake: Path) -> None:
    """A covered US CIK read BEFORE any fact is knowable (2020) yields ``({}, None, None, None)`` — an
    empty read stamps ``None`` (a miss), not a fabricated source over an empty dict. The look-ahead guard
    flows through from the store: nothing was filed by 2020."""
    s = Store(lake)
    li, source, obs, kts = pit_line_items(s, TickerIdentity("OLDT", "US"), _utc_ms(2020, 1, 1, 14, 30))
    assert (li, source, obs, kts) == ({}, None, None, None)
