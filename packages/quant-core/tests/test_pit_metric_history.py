"""Tests for ``quant_core.fundamentals.lake.contract.pit_metric_history`` — the public, PIT-safe,
bounded multi-period lake accessor (plan ``analyst-free-estimates-engine.md`` Task 1).

``pit_line_items`` returns only the single latest period; the analyst-free forecast engine needs the
full annual earnings *time-series* as-of a date. ``pit_metric_history`` exposes the lake's internal
``metric_series`` through the SAME CIK + sector resolution ``earnings_stability`` uses, oldest-first,
fail-closed for non-US, with the tail bounded by ``years`` (never an unbounded read). These tests pin:

  1. **A covered US name → its oldest-first annual series ≤ as_of**, each point carrying exactly
     ``{value, end, knowledge_ts, filed, accession}``.
  2. **PIT-safety** — an as-of in the past excludes a later-``knowledge_ts`` restatement (the store's
     look-ahead guard flows through); the as-of-after read sees the restated value.
  3. **Non-US → ``[]``** fail-closed (no EDGAR, no Yahoo), same axis as ``pit_line_items``.
  4. **The ``years`` bound clips the tail** — points older than ``as_of − years·year`` are dropped, and
     the survivors stay oldest-first.

Plus the contract details the accessor inherits from ``pit_line_items``: an unknown/cold name → ``[]``;
sector-aware resolution (a bank's ``total_revenue`` resolves via the registry override); a derived
(TTM) point reports ``knowledge_ts = None`` rather than raising.

The synthetic lake is built with the real Task-3 ``SCHEMA`` (so ``store`` + ``metrics`` + ``contract``
run end-to-end, no read-engine mocks), reusing the fixture helpers from ``test_lake_contract``. pyarrow
+ duckdb are the ``quant-core[lake]`` extra — the docker gate installs ``[lake]`` so this suite runs
there; locally it ``importorskip``s both.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")
pytest.importorskip("duckdb")

from quant_core.fundamentals.lake.contract import pit_metric_history  # noqa: E402
from quant_core.fundamentals.lake.schema import SCHEMA  # noqa: E402
from quant_core.fundamentals.lake.store import Store  # noqa: E402
from quant_core.ticker_identity import TickerIdentity  # noqa: E402

# The provenance fields the accessor promises on every point (plan Task 1: "each point keeps
# value/end/knowledge_ts/filed/accession").
_POINT_FIELDS = {"value", "end", "knowledge_ts", "filed", "accession"}

# Identity-table schemas — mirror the harvester's writers, same as test_lake_contract.
_TICKER_SCHEMA = pa.schema(
    [
        ("cik", pa.int32()),
        ("ticker", pa.string()),
        ("valid_from", pa.date32()),
        ("valid_to", pa.date32()),
    ]
)
_ENTITY_SCHEMA = pa.schema(
    [
        ("cik", pa.int32()),
        ("name", pa.string()),
        ("sic", pa.string()),
        ("sic_desc", pa.string()),
        ("exchanges", pa.string()),
        ("tickers", pa.string()),
        ("former_names", pa.string()),
    ]
)


def _ms(y: int, mo: int, d: int, h: int = 14, mi: int = 30) -> int:
    """A UTC wall-clock instant as a UTC-ms epoch (the ``knowledge_ts`` / ``as_of_ms`` unit)."""
    return int(datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp() * 1000)


def _fact(
    *,
    cik: int,
    concept: str,
    value: float,
    end: str,
    knowledge_ts: int,
    accession: str,
    start: str | None = None,
    taxonomy: str = "us-gaap",
    unit: str = "USD",
    fy: int = 2023,
    fp: str = "FY",
    form: str = "10-K",
    filed: str = "2024-02-15",
) -> dict:
    """One fact row in the Task-3 SCHEMA shape (dates as ``date``, ms axes as int)."""
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
        "accepted_ts": None,
        "knowledge_ts": knowledge_ts,
        "frame": None,
    }


def _annual(
    cik: int,
    concept: str,
    fy: int,
    value: float,
    kts: int,
    *,
    accession: str | None = None,
    filed: str | None = None,
    taxonomy: str = "us-gaap",
    unit: str = "USD",
) -> dict:
    """A full-year duration fact (Jan 1 .. Dec 31 of ``fy``) — classed annual by ``split_periods``.

    ``accession`` / ``filed`` default to one per (concept, fy); a restatement test overrides them so the
    original print and the 10-K/A share a period but differ on ``knowledge_ts`` / ``accession``.
    """
    return _fact(
        cik=cik,
        concept=concept,
        value=value,
        start=f"{fy}-01-01",
        end=f"{fy}-12-31",
        knowledge_ts=kts,
        accession=accession or f"{concept[:3]}-{fy}",
        taxonomy=taxonomy,
        unit=unit,
        fy=fy,
        fp="FY",
        form="10-K",
        filed=filed or f"{fy + 1}-02-15",
    )


def _write_facts(lake: Path, cik: int, rows: list[dict]) -> None:
    out = lake / "facts"
    out.mkdir(parents=True, exist_ok=True)
    pq.write_table(
        pa.Table.from_pylist(rows, schema=SCHEMA),
        out / f"cik={int(cik):010d}.parquet",
        compression="zstd",
    )


def _write_ticker_history(lake: Path, rows: list[dict]) -> None:
    pq.write_table(
        pa.Table.from_pylist(rows, schema=_TICKER_SCHEMA),
        lake / "ticker_history.parquet",
        compression="zstd",
    )


def _write_entities(lake: Path, rows: list[dict]) -> None:
    pq.write_table(
        pa.Table.from_pylist(rows, schema=_ENTITY_SCHEMA),
        lake / "entities.parquet",
        compression="zstd",
    )


def _entity(cik: int, ticker: str, *, sic: str = "7372") -> dict:
    """An ``entities.parquet`` row (SIC 7372 = Software → the ``general`` template by default)."""
    return {
        "cik": cik,
        "name": f"{ticker} Co",
        "sic": sic,
        "sic_desc": "Test",
        "exchanges": json.dumps(["NYSE"]),
        "tickers": json.dumps([ticker]),
        "former_names": json.dumps([]),
    }


def _ticker_row(cik: int, ticker: str) -> dict:
    return {"cik": cik, "ticker": ticker, "valid_from": date(2000, 1, 1), "valid_to": None}


CIK_FULL = 100   # five consecutive net-income annuals FY2019..FY2023
AS_OF = _ms(2024, 6, 1)   # after the FY2023 10-K is knowable; well before any 10y tail clip


@pytest.fixture()
def lake(tmp_path: Path) -> Path:
    """A synthetic lake: one US name with a five-year annual net-income series + the identity tables.

    Net income FY2019..FY2023 = 70/80/90/100/110, each knowable mid-Feb of the following year.
    """
    root = tmp_path / "lake"
    root.mkdir()
    rows = [
        _annual(CIK_FULL, "NetIncomeLoss", 2019, 70.0, _ms(2020, 2, 16)),
        _annual(CIK_FULL, "NetIncomeLoss", 2020, 80.0, _ms(2021, 2, 16)),
        _annual(CIK_FULL, "NetIncomeLoss", 2021, 90.0, _ms(2022, 2, 16)),
        _annual(CIK_FULL, "NetIncomeLoss", 2022, 100.0, _ms(2023, 2, 16)),
        _annual(CIK_FULL, "NetIncomeLoss", 2023, 110.0, _ms(2024, 2, 16)),
    ]
    _write_facts(root, CIK_FULL, rows)
    _write_ticker_history(root, [_ticker_row(CIK_FULL, "FULL")])
    _write_entities(root, [_entity(CIK_FULL, "FULL")])
    return root


# --------------------------------------------------------------------------------------------------- #
# 1. Covered US name → oldest-first annual series ≤ as_of, with the promised provenance fields         #
# --------------------------------------------------------------------------------------------------- #
def test_covered_us_name_returns_oldest_first_annual_series(lake: Path) -> None:
    s = Store(lake)
    pts = pit_metric_history(s, TickerIdentity("FULL", "US"), "net_income", "a", AS_OF)
    # All five annuals are knowable at AS_OF (2024-06), oldest-first (FY2019 → FY2023).
    values = [p["value"] for p in pts]
    assert values == [70.0, 80.0, 90.0, 100.0, 110.0]
    # Each point carries EXACTLY the promised provenance set — no more, no less (so a forecast layer
    # can age features+labels on `knowledge_ts` and key joins on `accession`).
    for p in pts:
        assert set(p) == _POINT_FIELDS
    # the points are real dates / the filing id, not coerced placeholders
    assert pts[-1]["end"] == date(2023, 12, 31)
    assert pts[-1]["knowledge_ts"] == _ms(2024, 2, 16)
    assert pts[-1]["accession"] == "Net-2023"
    assert pts[-1]["filed"] == date(2024, 2, 15)
    # oldest-first invariant explicitly (ascending by period-end)
    assert [p["end"] for p in pts] == sorted(p["end"] for p in pts)


def test_as_of_before_any_filing_is_empty(lake: Path) -> None:
    """A covered name read before its earliest fact is knowable → ``[]`` (a miss, not a fabrication)."""
    s = Store(lake)
    assert pit_metric_history(s, TickerIdentity("FULL", "US"), "net_income", "a", _ms(2019, 1, 1)) == []


def test_as_of_midway_sees_only_already_knowable_annuals(lake: Path) -> None:
    """An as-of in early-2023 (after the FY2022 10-K, before FY2023's) sees FY2019..FY2022 only."""
    s = Store(lake)
    pts = pit_metric_history(s, TickerIdentity("FULL", "US"), "net_income", "a", _ms(2023, 3, 1))
    assert [p["value"] for p in pts] == [70.0, 80.0, 90.0, 100.0]   # FY2023 not yet knowable


# --------------------------------------------------------------------------------------------------- #
# 2. PIT-safety — an as-of in the past excludes a later-knowledge_ts restatement                       #
# --------------------------------------------------------------------------------------------------- #
def test_as_of_in_the_past_excludes_later_restatement(tmp_path: Path) -> None:
    """A 10-K/A restatement of FY2022 (a later ``knowledge_ts``) must be invisible to an as-of read at
    the original FY2022 print date — the store's look-ahead guard flows through. After the restatement
    is knowable, the as-of read returns the RESTATED value (latest-known-wins on the same period)."""
    root = tmp_path / "restate"
    root.mkdir()
    orig_kts = _ms(2023, 2, 16)        # the first FY2022 10-K
    amend_kts = _ms(2023, 8, 1)        # a later 10-K/A restating FY2022
    rows = [
        _annual(900, "NetIncomeLoss", 2021, 90.0, _ms(2022, 2, 16)),
        _annual(900, "NetIncomeLoss", 2022, 100.0, orig_kts, accession="NIL-2022-orig"),
        # the restatement: same period (FY2022), a different value, knowable later
        _annual(900, "NetIncomeLoss", 2022, 88.0, amend_kts,
                accession="NIL-2022-amend", filed="2023-07-31"),
    ]
    _write_facts(root, 900, rows)
    _write_ticker_history(root, [_ticker_row(900, "RSTN")])
    _write_entities(root, [_entity(900, "RSTN")])
    s = Store(root)

    # As-of at the ORIGINAL print (before the amendment is knowable): FY2022 = the first print, 100.
    early = pit_metric_history(s, TickerIdentity("RSTN", "US"), "net_income", "a", _ms(2023, 3, 1))
    fy22_early = next(p for p in early if p["end"] == date(2022, 12, 31))
    assert fy22_early["value"] == 100.0
    assert fy22_early["accession"] == "NIL-2022-orig"
    # the later restatement does NOT leak in (only one FY2022 row, the original)
    assert sum(1 for p in early if p["end"] == date(2022, 12, 31)) == 1

    # As-of AFTER the amendment is knowable: latest-known-wins → FY2022 = the restated 88.
    late = pit_metric_history(s, TickerIdentity("RSTN", "US"), "net_income", "a", _ms(2023, 9, 1))
    fy22_late = next(p for p in late if p["end"] == date(2022, 12, 31))
    assert fy22_late["value"] == 88.0
    assert fy22_late["accession"] == "NIL-2022-amend"
    assert sum(1 for p in late if p["end"] == date(2022, 12, 31)) == 1


# --------------------------------------------------------------------------------------------------- #
# 3. Non-US / unresolved → [] fail-closed                                                              #
# --------------------------------------------------------------------------------------------------- #
def test_non_us_name_is_fail_closed_empty(lake: Path) -> None:
    """A non-US (LSE) identity returns ``[]`` immediately — no EDGAR, no Yahoo (Thread C). Same
    fail-closed axis as ``pit_line_items`` (which short-circuits any ``market != 'US'`` the SAME way;
    ``TickerIdentity.market`` is ``Literal['US','LSE']``, so LSE is the representative non-US case)."""
    s = Store(lake)
    assert pit_metric_history(s, TickerIdentity("FULL", "LSE"), "net_income", "a", AS_OF) == []


def test_unknown_us_symbol_is_fail_closed_empty(lake: Path) -> None:
    """A US symbol absent from ticker_history resolves to no CIK → ``[]``."""
    s = Store(lake)
    assert pit_metric_history(s, TickerIdentity("ZZZZ", "US"), "net_income", "a", AS_OF) == []


def test_cold_lake_is_fail_closed_empty(tmp_path: Path) -> None:
    """A cold lake (no files) → ``[]`` for any name (the store degrades, the accessor with it)."""
    cold = tmp_path / "cold"
    cold.mkdir()
    s = Store(cold)
    assert pit_metric_history(s, TickerIdentity("FULL", "US"), "net_income", "a", AS_OF) == []


# --------------------------------------------------------------------------------------------------- #
# 4. The `years` bound clips the tail (never an unbounded read)                                        #
# --------------------------------------------------------------------------------------------------- #
def test_years_bound_clips_the_oldest_points(lake: Path) -> None:
    """With ``years=3`` an as-of of 2024-06-01 keeps only points whose period-end ≥ ~2021-06 — so
    FY2021/FY2022/FY2023 survive and FY2019/FY2020 (ends 2019/2020-12-31, older than the window) are
    dropped. The survivors stay oldest-first."""
    s = Store(lake)
    pts = pit_metric_history(s, TickerIdentity("FULL", "US"), "net_income", "a", AS_OF, years=3)
    assert [p["value"] for p in pts] == [90.0, 100.0, 110.0]   # FY2021..FY2023
    assert [p["end"] for p in pts] == [date(2021, 12, 31), date(2022, 12, 31), date(2023, 12, 31)]


def test_years_bound_is_inclusive_at_the_boundary(lake: Path) -> None:
    """The bound is ``end >= as_of − years·year`` (inclusive). years=1 from 2024-06 keeps only a point
    whose end is within ~365.25 days back — FY2023 (2023-12-31) qualifies; FY2022 (2022-12-31) does
    not. A larger years (10, the default) keeps the whole five-year series."""
    s = Store(lake)
    one = pit_metric_history(s, TickerIdentity("FULL", "US"), "net_income", "a", AS_OF, years=1)
    assert [p["value"] for p in one] == [110.0]   # only FY2023 within the 1y tail
    full = pit_metric_history(s, TickerIdentity("FULL", "US"), "net_income", "a", AS_OF, years=10)
    assert len(full) == 5   # the default 10y comfortably holds the whole series


def test_years_bound_never_unbounded_default(lake: Path) -> None:
    """Sanity: even the default (10) is a bound — a point far older than 10y would be excluded. Here
    the whole series is < 10y old, so all five survive, proving the default does not over-clip."""
    s = Store(lake)
    pts = pit_metric_history(s, TickerIdentity("FULL", "US"), "net_income", "a", AS_OF)
    assert len(pts) == 5
    assert pts[0]["value"] == 70.0   # FY2019, ~5y before AS_OF, still inside 10y


# --------------------------------------------------------------------------------------------------- #
# 5. Contract details inherited from pit_line_items: sector resolution + derived-point knowledge_ts    #
# --------------------------------------------------------------------------------------------------- #
def test_sector_template_governs_metric_resolution(tmp_path: Path) -> None:
    """A bank (SIC 6022) resolves ``total_revenue`` via the registry's per-sector concept override
    (net interest income, NOT us-gaap:Revenues), exactly as ``pit_line_items`` threads the SIC template
    through — so the multi-period accessor is sector-aware on the same axis."""
    root = tmp_path / "bank"
    root.mkdir()
    k21, k22 = _ms(2022, 2, 16), _ms(2023, 2, 16)
    # A bank reports revenue under RevenuesNetOfInterestExpense, not Revenues. If the accessor were
    # sector-blind it would resolve nothing (the default `Revenues` concept is absent).
    rows = [
        _annual(910, "RevenuesNetOfInterestExpense", 2021, 500.0, k21),
        _annual(910, "RevenuesNetOfInterestExpense", 2022, 540.0, k22),
    ]
    _write_facts(root, 910, rows)
    _write_ticker_history(root, [_ticker_row(910, "BANK")])
    _write_entities(root, [_entity(910, "BANK", sic="6022")])   # 6022 = state commercial bank
    s = Store(root)
    pts = pit_metric_history(s, TickerIdentity("BANK", "US"), "total_revenue", "a", _ms(2023, 6, 1))
    assert [p["value"] for p in pts] == [500.0, 540.0]   # resolved via the bank override


def test_derived_ttm_point_carries_max_input_knowledge_ts(tmp_path: Path) -> None:
    """A derived (TTM) point is well-formed — full field set, and its ``knowledge_ts`` is the MAX of the
    four input quarters' (a TTM is knowable only once all four quarters are public; ``metrics`` carries
    ``_max_knowledge_ts(window)``, the PIT-safe instant). The accessor reads it via ``.get`` so a future
    derived-row path that omitted the field would report ``None`` rather than raise — but the present
    contract is a real carried instant, which this pins."""
    root = tmp_path / "ttm"
    root.mkdir()
    # four consecutive 2023 quarters → one TTM point. The completing Q4 is the latest-knowable input.
    q4_kts = _ms(2024, 2, 1)
    quarters = [
        ("2023-01-01", "2023-03-31", 25.0, _ms(2023, 5, 1)),
        ("2023-04-01", "2023-06-30", 26.0, _ms(2023, 8, 1)),
        ("2023-07-01", "2023-09-30", 27.0, _ms(2023, 11, 1)),
        ("2023-10-01", "2023-12-31", 28.0, q4_kts),
    ]
    rows = [
        _fact(cik=920, concept="NetIncomeLoss", value=v, start=s0, end=e0, knowledge_ts=k,
              accession=f"Q-{e0}", form="10-Q", fp="Q")
        for (s0, e0, v, k) in quarters
    ]
    _write_facts(root, 920, rows)
    _write_ticker_history(root, [_ticker_row(920, "TTMN")])
    _write_entities(root, [_entity(920, "TTMN")])
    s = Store(root)
    pts = pit_metric_history(s, TickerIdentity("TTMN", "US"), "net_income", "ttm", _ms(2024, 6, 1))
    assert len(pts) == 1
    tp = pts[0]
    assert tp["value"] == pytest.approx(25.0 + 26.0 + 27.0 + 28.0)   # the TTM sum
    assert tp["end"] == date(2023, 12, 31)
    assert set(tp) == _POINT_FIELDS                  # still the full promised field set...
    assert tp["knowledge_ts"] == q4_kts              # ...and the PIT-correct max-input instant (the Q4)
