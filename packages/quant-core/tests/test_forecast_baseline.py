"""Tests for ``quant_core.forecast.baseline`` — the no-drift seasonal random-walk annual-EPS floor.

The baseline forecast is the latest as-of, split-adjusted annual EPS, presented identically at every
horizon (no drift — Bradshaw et al. 2012). These tests pin the design contract from plan
``analyst-free-estimates-engine.md`` Task 3 + the research §"Seasonal RW baseline":

  1. **RW = the last annual EPS, no drift** — the forecast equals ``net_income(latest FY) ÷ shares``,
     and is identical across t+1 / t+2 / t+3 (golden vectors hand-computed below).
  2. **Thin history → ``None``** — a name with no knowable annual earnings point as-of (cold/young) is
     omitted, never zero-filled. A name with earnings but no share count is likewise ``None``.
  3. **Negative base-year → ``None``** — a loss in the latest fiscal year excludes the RW (no walk off
     a loss), even when earlier years were profitable.
  4. **Split-adjustment continuity** — every fiscal year's net income is divided by the SAME (latest)
     share count, so a stock split between two years does NOT inject a per-share discontinuity; the EPS
     series moves only with earnings.
  5. **Non-US → ``None``** — fail-closed (no EDGAR, no Yahoo), the same axis as ``pit_metric_history``.
  6. **PIT-safety inherited** — an as-of in the past forecasts off the then-latest annual, not a
     later-``knowledge_ts`` figure.

The synthetic lake is built with the real Task-3 ``SCHEMA`` (so ``store`` + ``metrics`` + ``contract``
run end-to-end, no read-engine mocks), mirroring the fixture helpers from ``test_pit_metric_history`` /
``test_lake_contract``. pyarrow + duckdb are the ``quant-core[lake]`` extra — the docker gate installs
``[lake]`` so this suite runs there; locally it ``importorskip``s both.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")
pytest.importorskip("duckdb")

from quant_core.forecast.baseline import (  # noqa: E402
    HORIZONS,
    seasonal_random_walk_eps,
    seasonal_random_walk_eps_path,
)
from quant_core.fundamentals.lake.schema import SCHEMA  # noqa: E402
from quant_core.fundamentals.lake.store import Store  # noqa: E402
from quant_core.ticker_identity import TickerIdentity  # noqa: E402

# --------------------------------------------------------------------------------------------------- #
# Fixture helpers — the Task-3 lake SCHEMA + identity tables (mirrors test_pit_metric_history).        #
# --------------------------------------------------------------------------------------------------- #
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


def _ni_annual(cik: int, fy: int, value: float, kts: int, *, accession: str | None = None) -> dict:
    """A full-year ``NetIncomeLoss`` duration fact (Jan 1 .. Dec 31 of ``fy``) — classed annual."""
    return _fact(
        cik=cik,
        concept="NetIncomeLoss",
        value=value,
        start=f"{fy}-01-01",
        end=f"{fy}-12-31",
        knowledge_ts=kts,
        accession=accession or f"NIL-{fy}",
        fy=fy,
        fp="FY",
        form="10-K",
        filed=f"{fy + 1}-02-15",
    )


def _shares_instant(cik: int, end: str, value: float, kts: int, *, accession: str | None = None) -> dict:
    """A dei cover-page ``EntityCommonStockSharesOutstanding`` instant (no ``start``) — the PIT count."""
    return _fact(
        cik=cik,
        concept="EntityCommonStockSharesOutstanding",
        value=value,
        end=end,
        knowledge_ts=kts,
        accession=accession or f"SHR-{end[:4]}",
        taxonomy="dei",
        unit="shares",
        form="10-K",
        filed=f"{int(end[:4]) + 1}-02-15",
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


def _build_lake(
    tmp_path: Path, cik: int, ticker: str, rows: list[dict], *, sic: str = "7372"
) -> Store:
    """Write a one-name synthetic lake (facts + identity tables) and return an opened ``Store``."""
    root = tmp_path / "lake"
    root.mkdir(exist_ok=True)
    _write_facts(root, cik, rows)
    _write_ticker_history(root, [_ticker_row(cik, ticker)])
    _write_entities(root, [_entity(cik, ticker, sic=sic)])
    return Store(root)


# A clean as-of after every FY2023 fact below is knowable, well before any 10y tail clip.
AS_OF = _ms(2024, 6, 1)


# --------------------------------------------------------------------------------------------------- #
# 1. RW = the last annual EPS — no drift; golden vectors; identical across horizons                    #
# --------------------------------------------------------------------------------------------------- #
def test_rw_is_latest_annual_eps_golden_vector(tmp_path: Path) -> None:
    """Net income 70/80/90/100/110 over FY2019..FY2023, 50 shares → EPS 1.4/1.6/1.8/2.0/2.2.

    The no-drift RW forecast is the LATEST annual EPS = 110/50 = 2.2 — NOT extrapolated past it (a
    with-drift RW off the +0.2/yr trend would predict 2.4; no-drift does not)."""
    rows = [
        _ni_annual(100, 2019, 70.0, _ms(2020, 2, 16)),
        _ni_annual(100, 2020, 80.0, _ms(2021, 2, 16)),
        _ni_annual(100, 2021, 90.0, _ms(2022, 2, 16)),
        _ni_annual(100, 2022, 100.0, _ms(2023, 2, 16)),
        _ni_annual(100, 2023, 110.0, _ms(2024, 2, 16)),
        _shares_instant(100, "2023-12-31", 50.0, _ms(2024, 2, 16)),
    ]
    store = _build_lake(tmp_path, 100, "FULL", rows)
    forecast = seasonal_random_walk_eps(store, TickerIdentity("FULL", "US"), AS_OF)
    assert forecast == pytest.approx(2.2)  # 110 / 50 — the base year itself, no drift past it


def test_rw_path_is_flat_across_horizons(tmp_path: Path) -> None:
    """No drift ⇒ the t+1 / t+2 / t+3 forecasts are all the same value (the latest annual EPS)."""
    rows = [
        _ni_annual(101, 2022, 100.0, _ms(2023, 2, 16)),
        _ni_annual(101, 2023, 110.0, _ms(2024, 2, 16)),
        _shares_instant(101, "2023-12-31", 50.0, _ms(2024, 2, 16)),
    ]
    store = _build_lake(tmp_path, 101, "FLAT", rows)
    path = seasonal_random_walk_eps_path(store, TickerIdentity("FLAT", "US"), AS_OF)
    assert path == {1: pytest.approx(2.2), 2: pytest.approx(2.2), 3: pytest.approx(2.2)}
    assert set(path) == set(HORIZONS)
    # every horizon carries the SAME scalar — the defining property of a no-drift walk
    assert len(set(path.values())) == 1


def test_single_annual_point_is_enough(tmp_path: Path) -> None:
    """One knowable annual EPS is sufficient for a no-drift RW — the forecast IS that one value."""
    rows = [
        _ni_annual(102, 2023, 90.0, _ms(2024, 2, 16)),
        _shares_instant(102, "2023-12-31", 30.0, _ms(2024, 2, 16)),
    ]
    store = _build_lake(tmp_path, 102, "ONE", rows)
    assert seasonal_random_walk_eps(store, TickerIdentity("ONE", "US"), AS_OF) == pytest.approx(3.0)


# --------------------------------------------------------------------------------------------------- #
# 2. Thin history → None (omitted, never zero-filled)                                                  #
# --------------------------------------------------------------------------------------------------- #
def test_no_annual_earnings_known_as_of_is_none(tmp_path: Path) -> None:
    """An as-of BEFORE the only annual is knowable → no base year → ``None`` (a miss, not a 0)."""
    rows = [
        _ni_annual(110, 2023, 90.0, _ms(2024, 2, 16)),
        _shares_instant(110, "2023-12-31", 30.0, _ms(2024, 2, 16)),
    ]
    store = _build_lake(tmp_path, 110, "YOUNG", rows)
    # as-of 2023-06 — the FY2023 10-K is not yet knowable (knowledge_ts 2024-02-16)
    assert seasonal_random_walk_eps(store, TickerIdentity("YOUNG", "US"), _ms(2023, 6, 1)) is None


def test_cold_lake_is_none(tmp_path: Path) -> None:
    """A cold lake (no files) → ``None`` for any name (the store degrades, the baseline with it)."""
    cold = tmp_path / "cold"
    cold.mkdir()
    store = Store(cold)
    assert seasonal_random_walk_eps(store, TickerIdentity("FULL", "US"), AS_OF) is None


def test_unknown_symbol_is_none(tmp_path: Path) -> None:
    """A US symbol absent from ticker_history resolves to no CIK → ``None``."""
    rows = [
        _ni_annual(111, 2023, 90.0, _ms(2024, 2, 16)),
        _shares_instant(111, "2023-12-31", 30.0, _ms(2024, 2, 16)),
    ]
    store = _build_lake(tmp_path, 111, "REAL", rows)
    assert seasonal_random_walk_eps(store, TickerIdentity("ZZZZ", "US"), AS_OF) is None


def test_earnings_but_no_shares_is_none(tmp_path: Path) -> None:
    """Net income present but NO share count → EPS undefined → ``None`` (never net_income as a 'price')."""
    rows = [
        _ni_annual(112, 2023, 90.0, _ms(2024, 2, 16)),
        # no shares_outstanding fact written
    ]
    store = _build_lake(tmp_path, 112, "NOSH", rows)
    assert seasonal_random_walk_eps(store, TickerIdentity("NOSH", "US"), AS_OF) is None


def test_zero_share_count_is_none(tmp_path: Path) -> None:
    """A zero share count is a fabricated/empty denominator → fail-closed ``None`` (no div-by-zero)."""
    rows = [
        _ni_annual(113, 2023, 90.0, _ms(2024, 2, 16)),
        _shares_instant(113, "2023-12-31", 0.0, _ms(2024, 2, 16)),
    ]
    store = _build_lake(tmp_path, 113, "ZEROSH", rows)
    assert seasonal_random_walk_eps(store, TickerIdentity("ZEROSH", "US"), AS_OF) is None


# --------------------------------------------------------------------------------------------------- #
# 3. Negative base-year → None (no random walk off a loss)                                             #
# --------------------------------------------------------------------------------------------------- #
def test_negative_base_year_is_none(tmp_path: Path) -> None:
    """Latest annual net income < 0 → ``None`` even though earlier years were profitable (no RW off a
    loss; the downstream growth leg would be undefined, so the base year is excluded)."""
    rows = [
        _ni_annual(120, 2021, 90.0, _ms(2022, 2, 16)),
        _ni_annual(120, 2022, 100.0, _ms(2023, 2, 16)),
        _ni_annual(120, 2023, -40.0, _ms(2024, 2, 16)),   # the loss year is the base year
        _shares_instant(120, "2023-12-31", 50.0, _ms(2024, 2, 16)),
    ]
    store = _build_lake(tmp_path, 120, "LOSS", rows)
    assert seasonal_random_walk_eps(store, TickerIdentity("LOSS", "US"), AS_OF) is None
    assert seasonal_random_walk_eps_path(store, TickerIdentity("LOSS", "US"), AS_OF) is None


def test_zero_base_year_is_none(tmp_path: Path) -> None:
    """An exactly-breakeven base year (EPS == 0) is excluded too (``<= 0`` — growth undefined)."""
    rows = [
        _ni_annual(121, 2022, 100.0, _ms(2023, 2, 16)),
        _ni_annual(121, 2023, 0.0, _ms(2024, 2, 16)),
        _shares_instant(121, "2023-12-31", 50.0, _ms(2024, 2, 16)),
    ]
    store = _build_lake(tmp_path, 121, "BREAKEVEN", rows)
    assert seasonal_random_walk_eps(store, TickerIdentity("BREAKEVEN", "US"), AS_OF) is None


def test_recovered_base_year_after_earlier_loss_is_forecast(tmp_path: Path) -> None:
    """An EARLIER loss does not disqualify the name — only the BASE year matters. FY2023 = +110 → 2.2."""
    rows = [
        _ni_annual(122, 2021, -50.0, _ms(2022, 2, 16)),   # an old loss
        _ni_annual(122, 2022, 60.0, _ms(2023, 2, 16)),
        _ni_annual(122, 2023, 110.0, _ms(2024, 2, 16)),   # the base year is profitable
        _shares_instant(122, "2023-12-31", 50.0, _ms(2024, 2, 16)),
    ]
    store = _build_lake(tmp_path, 122, "RECOVER", rows)
    assert seasonal_random_walk_eps(store, TickerIdentity("RECOVER", "US"), AS_OF) == pytest.approx(2.2)


# --------------------------------------------------------------------------------------------------- #
# 4. Split-adjustment continuity — one current share basis, so a split injects no discontinuity        #
# --------------------------------------------------------------------------------------------------- #
def test_split_adjustment_uses_latest_share_basis(tmp_path: Path) -> None:
    """A 2:1 split between FY2022 and FY2023 doubles the as-reported count (50 → 100). Dividing BOTH
    years' net income by the LATEST (post-split) count = 100 puts the series on one current basis:
    FY2022 EPS = 100/100 = 1.0, FY2023 EPS = 110/100 = 1.1. The forecast = the latest = 1.1.

    The split-adjustment is what keeps continuity: were FY2022 divided by its own pre-split 50 (=2.0)
    and FY2023 by 100 (=1.1), the series would show a spurious ~½× drop driven by the split, not by
    earnings. The baseline reads ONLY the latest share count, so no such discontinuity appears."""
    rows = [
        _ni_annual(130, 2022, 100.0, _ms(2023, 2, 16)),
        _ni_annual(130, 2023, 110.0, _ms(2024, 2, 16)),
        # pre-split cover-page count at FY2022 year-end ...
        _shares_instant(130, "2022-12-31", 50.0, _ms(2023, 2, 16)),
        # ... and the post-2:1-split count at FY2023 year-end (the latest known) — the current basis
        _shares_instant(130, "2023-12-31", 100.0, _ms(2024, 2, 16)),
    ]
    store = _build_lake(tmp_path, 130, "SPLIT", rows)
    forecast = seasonal_random_walk_eps(store, TickerIdentity("SPLIT", "US"), AS_OF)
    assert forecast == pytest.approx(1.1)  # 110 / 100 (the latest, post-split basis)


def test_split_adjusted_as_of_past_uses_then_current_basis(tmp_path: Path) -> None:
    """PIT: an as-of BEFORE the split is knowable forecasts off the then-latest count (50). The same
    name read after the split forecasts off 100 — each as-of reads only what was knowable then.

    Reusing the FY2022/FY2023 split lake: an as-of in early-2023 (FY2023 + the post-split count NOT yet
    knowable) sees FY2022 net income 100 ÷ the then-latest count 50 = 2.0."""
    rows = [
        _ni_annual(131, 2022, 100.0, _ms(2023, 2, 16)),
        _ni_annual(131, 2023, 110.0, _ms(2024, 2, 16)),
        _shares_instant(131, "2022-12-31", 50.0, _ms(2023, 2, 16)),
        _shares_instant(131, "2023-12-31", 100.0, _ms(2024, 2, 16)),
    ]
    store = _build_lake(tmp_path, 131, "SPLITPIT", rows)
    # as-of 2023-06 — FY2022 is the latest knowable annual, 50 the latest knowable share count
    early = seasonal_random_walk_eps(store, TickerIdentity("SPLITPIT", "US"), _ms(2023, 6, 1))
    assert early == pytest.approx(2.0)  # 100 / 50, the then-current basis
    # as-of after the split → 1.1 (the post-split basis), proving the basis tracks the as-of
    late = seasonal_random_walk_eps(store, TickerIdentity("SPLITPIT", "US"), AS_OF)
    assert late == pytest.approx(1.1)


# --------------------------------------------------------------------------------------------------- #
# 5. Non-US → None fail-closed (no EDGAR, no Yahoo)                                                     #
# --------------------------------------------------------------------------------------------------- #
def test_non_us_name_is_none(tmp_path: Path) -> None:
    """An LSE identity → ``None`` immediately — ``pit_metric_history`` short-circuits any non-US market
    (no EDGAR, no Yahoo, Thread C), so the baseline omits it."""
    rows = [
        _ni_annual(140, 2023, 90.0, _ms(2024, 2, 16)),
        _shares_instant(140, "2023-12-31", 30.0, _ms(2024, 2, 16)),
    ]
    store = _build_lake(tmp_path, 140, "FULL", rows)
    assert seasonal_random_walk_eps(store, TickerIdentity("FULL", "LSE"), AS_OF) is None
    assert seasonal_random_walk_eps_path(store, TickerIdentity("FULL", "LSE"), AS_OF) is None


# --------------------------------------------------------------------------------------------------- #
# 6. PIT-safety inherited — forecasts off the then-latest annual, not a later restatement              #
# --------------------------------------------------------------------------------------------------- #
def test_pit_forecast_uses_then_latest_annual(tmp_path: Path) -> None:
    """An as-of after FY2022's print but before FY2023's forecasts off FY2022 (the then-base year),
    not the future FY2023 figure. FY2022 net income 100 / 50 = 2.0."""
    rows = [
        _ni_annual(150, 2022, 100.0, _ms(2023, 2, 16)),
        _ni_annual(150, 2023, 110.0, _ms(2024, 2, 16)),
        _shares_instant(150, "2022-12-31", 50.0, _ms(2023, 2, 16)),
        _shares_instant(150, "2023-12-31", 50.0, _ms(2024, 2, 16)),
    ]
    store = _build_lake(tmp_path, 150, "PIT", rows)
    early = seasonal_random_walk_eps(store, TickerIdentity("PIT", "US"), _ms(2023, 6, 1))
    assert early == pytest.approx(2.0)  # FY2022, not the not-yet-known FY2023 (2.2)


def test_restatement_of_base_year_respects_knowledge_ts(tmp_path: Path) -> None:
    """A 10-K/A restating the FY2023 base year is invisible until knowable. Before it: forecast off the
    original 110 → 2.2. After it: off the restated 88 → 1.76 (latest-known-wins on the same period)."""
    rows = [
        _ni_annual(151, 2023, 110.0, _ms(2024, 2, 16), accession="NIL-2023-orig"),
        _ni_annual(151, 2023, 88.0, _ms(2024, 8, 1), accession="NIL-2023-amend"),  # restatement
        _shares_instant(151, "2023-12-31", 50.0, _ms(2024, 2, 16)),
    ]
    store = _build_lake(tmp_path, 151, "RESTATE", rows)
    # as-of 2024-06 — before the amendment (knowable 2024-08) → original print
    before = seasonal_random_walk_eps(store, TickerIdentity("RESTATE", "US"), _ms(2024, 6, 1))
    assert before == pytest.approx(2.2)  # 110 / 50
    # as-of 2024-09 — the restatement is now knowable → the restated value wins
    after = seasonal_random_walk_eps(store, TickerIdentity("RESTATE", "US"), _ms(2024, 9, 1))
    assert after == pytest.approx(1.76)  # 88 / 50
