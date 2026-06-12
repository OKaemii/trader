"""Tests for the PIT-lake platform contract (epic Task 6) —
``quant_core.fundamentals.lake.contract.pit_line_items``.

This is the layer that turns the lake's standardized PIT series into the byte-compatible
``line_items`` dict the fundamentals seam serves. These tests pin the behaviours the seam's
correctness rests on, over a SYNTHETIC lake built with the real Task-3 ``SCHEMA`` (so the on-disk
column contract the harvester writes is exercised through ``store`` + ``metrics`` + ``contract``
end-to-end — no mocks of the read engine):

  1. **A covered US name → the full leg set with CANONICAL spellings.** All 4 flows + 7 instants +
     ``earnings_stability`` resolve → ≥ 12 keys, every key a real ``LINE_ITEMS`` member, no enriched
     ``market_cap_gbp`` / ``dividend_yield`` (those are the API's job).
  2. **An LSE name → ``{}`` fail-closed.** Non-US has no EDGAR and NO Yahoo fallback (Thread C).
  3. **A missing leg is OMITTED, never 0.** A name whose filings lack (say) ``GrossProfit`` returns a
     dict WITHOUT that key — `key not in dict`, not `dict[key] == 0` (a fabricated 0 would corrupt a
     ratio).
  4. **``earnings_stability``** is ``None`` with < 3 annual net-income points and a sane positive
     number with a steady series (and the documented inverse-CV magnitude).
  5. **TTM-preferred-over-annual for flows.** When both a TTM (4 consecutive quarters) and an annual
     are knowable, the flow leg takes the TTM value.
  6. **PIT-safety.** A leg whose ``knowledge_ts`` is in the future is not seen (the look-ahead guard
     flows through from the store); ``observation_ts`` / ``knowledge_ts`` are derived as documented.

pyarrow + duckdb are the ``quant-core[lake]`` extra — the docker gate installs ``[lake]`` so this
suite runs there; locally it ``importorskip``s both so the rest of the quant-core suite still
collects where they are absent. The fixtures write the SAME on-disk shapes the harvester produces:
per-CIK facts via the Task-3 ``SCHEMA`` plus ``ticker_history.parquet`` and ``entities.parquet``
(the Task-5 store-test shape, reused).
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
from quant_core.fundamentals.lake.contract import (  # noqa: E402
    earnings_stability,
    pit_line_items,
    ttm_or_annual,
)
from quant_core.fundamentals.lake.schema import SCHEMA  # noqa: E402
from quant_core.fundamentals.lake.store import Store  # noqa: E402
from quant_core.ticker_identity import TickerIdentity  # noqa: E402

# Mirror the harvester's identity writers (the store reads these columns by name) — same as the
# Task-5 store test, kept local so the synthetic lake is the EXACT on-disk shape.
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

CIK_FULL = 100        # a fully-covered US name (every leg)
CIK_PARTIAL = 200     # a name missing gross_profit (omission test)
CIK_FEW = 300         # only 2 annual net-income points (earnings_stability None)


def _ms(y: int, mo: int, d: int, h: int = 14, mi: int = 30) -> int:
    """A UTC wall-clock instant as a UTC-ms epoch (the `knowledge_ts` / `as_of_ms` unit)."""
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
    """One fact row in the Task-3 SCHEMA shape (dates as `date`, ms axes as int)."""
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


def _annual(cik: int, concept: str, fy: int, value: float, kts: int, *, taxonomy: str = "us-gaap",
            unit: str = "USD") -> dict:
    """A full-year duration fact (Jan 1 .. Dec 31 of `fy`) — `split_periods` classes it annual."""
    return _fact(cik=cik, concept=concept, value=value, start=f"{fy}-01-01", end=f"{fy}-12-31",
                 knowledge_ts=kts, accession=f"{concept[:3]}-{fy}", taxonomy=taxonomy, unit=unit,
                 fy=fy, fp="FY", form="10-K", filed=f"{fy + 1}-02-15")


def _instant(cik: int, concept: str, end: str, value: float, kts: int, *, taxonomy: str = "us-gaap",
             unit: str = "USD") -> dict:
    """A balance-sheet / cover-page instant fact (no `start`)."""
    return _fact(cik=cik, concept=concept, value=value, start=None, end=end, knowledge_ts=kts,
                 accession=f"{concept[:3]}-inst", taxonomy=taxonomy, unit=unit, form="10-K")


# A clean as-of after every fact below is knowable. The latest annual is FY2023 (knowable 2024-02-16).
AS_OF = _ms(2024, 6, 1)


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


def _full_name_facts(cik: int) -> list[dict]:
    """Every leg the contract assembles, for a fully-covered US name.

    Flows (resolved via the latest annual, FY2021..FY2023 so earnings_stability also has ≥3 points):
      net_income, total_revenue (Revenues), gross_profit (GrossProfit),
      cash_flow_ops (NetCashProvidedByUsedInOperatingActivities).
    Instants (latest period_end 2023-12-31):
      total_equity (StockholdersEquity), total_assets (Assets), total_liabilities (Liabilities),
      current_assets (AssetsCurrent), current_liabilities (LiabilitiesCurrent),
      total_debt (LongTermDebt — the 3rd select-fallback), shares_outstanding (dei cover-page).
    """
    k = _ms(2024, 2, 16)          # FY2023 10-K knowable
    k22, k21 = _ms(2023, 2, 16), _ms(2022, 2, 16)
    rows: list[dict] = []
    # net income — 3 annuals (FY21/22/23) so earnings_stability is defined
    rows += [
        _annual(cik, "NetIncomeLoss", 2021, 90.0, k21),
        _annual(cik, "NetIncomeLoss", 2022, 100.0, k22),
        _annual(cik, "NetIncomeLoss", 2023, 110.0, k),
    ]
    # other flows — one FY2023 annual each
    rows += [
        _annual(cik, "Revenues", 2023, 1000.0, k),
        _annual(cik, "GrossProfit", 2023, 400.0, k),
        _annual(cik, "NetCashProvidedByUsedInOperatingActivities", 2023, 150.0, k),
    ]
    # instants — all at 2023-12-31
    rows += [
        _instant(cik, "StockholdersEquity", "2023-12-31", 500.0, k),
        _instant(cik, "Assets", "2023-12-31", 1500.0, k),
        _instant(cik, "Liabilities", "2023-12-31", 1000.0, k),
        _instant(cik, "AssetsCurrent", "2023-12-31", 600.0, k),
        _instant(cik, "LiabilitiesCurrent", "2023-12-31", 300.0, k),
        _instant(cik, "LongTermDebt", "2023-12-31", 250.0, k),
        _instant(cik, "EntityCommonStockSharesOutstanding", "2023-12-31", 50.0, k,
                 taxonomy="dei", unit="shares"),
    ]
    return rows


@pytest.fixture()
def lake(tmp_path: Path) -> Path:
    """A synthetic lake with three US names + the identity tables.

    CIK_FULL: every leg present (the covered-name happy path).
    CIK_PARTIAL: every leg EXCEPT gross_profit (the omission test) — and only ONE net-income annual
      (earnings_stability None) so the two concerns are isolated per name.
    CIK_FEW: two net-income annuals (earnings_stability None: < 3 points).
    """
    root = tmp_path / "lake"
    root.mkdir()
    _write_facts(root, CIK_FULL, _full_name_facts(CIK_FULL))

    # CIK_PARTIAL: full minus GrossProfit, single net-income annual.
    k = _ms(2024, 2, 16)
    partial = [
        _annual(CIK_PARTIAL, "NetIncomeLoss", 2023, 110.0, k),
        _annual(CIK_PARTIAL, "Revenues", 2023, 1000.0, k),
        _annual(CIK_PARTIAL, "NetCashProvidedByUsedInOperatingActivities", 2023, 150.0, k),
        _instant(CIK_PARTIAL, "StockholdersEquity", "2023-12-31", 500.0, k),
        _instant(CIK_PARTIAL, "Assets", "2023-12-31", 1500.0, k),
        _instant(CIK_PARTIAL, "Liabilities", "2023-12-31", 1000.0, k),
        _instant(CIK_PARTIAL, "AssetsCurrent", "2023-12-31", 600.0, k),
        _instant(CIK_PARTIAL, "LiabilitiesCurrent", "2023-12-31", 300.0, k),
        _instant(CIK_PARTIAL, "LongTermDebt", "2023-12-31", 250.0, k),
        _instant(CIK_PARTIAL, "EntityCommonStockSharesOutstanding", "2023-12-31", 50.0, k,
                 taxonomy="dei", unit="shares"),
    ]
    _write_facts(root, CIK_PARTIAL, partial)

    _write_facts(root, CIK_FEW, [
        _annual(CIK_FEW, "NetIncomeLoss", 2022, 100.0, _ms(2023, 2, 16)),
        _annual(CIK_FEW, "NetIncomeLoss", 2023, 110.0, k),
    ])

    _write_ticker_history(root, [
        {"cik": CIK_FULL, "ticker": "FULL", "valid_from": date(2015, 1, 1), "valid_to": None},
        {"cik": CIK_PARTIAL, "ticker": "PART", "valid_from": date(2015, 1, 1), "valid_to": None},
        {"cik": CIK_FEW, "ticker": "FEWY", "valid_from": date(2015, 1, 1), "valid_to": None},
    ])
    _write_entities(root, [
        {"cik": CIK_FULL, "name": "Full Co", "sic": "7372", "sic_desc": "Software",
         "exchanges": json.dumps(["NYSE"]), "tickers": json.dumps(["FULL"]),
         "former_names": json.dumps([])},
        {"cik": CIK_PARTIAL, "name": "Part Co", "sic": "7372", "sic_desc": "Software",
         "exchanges": json.dumps(["NYSE"]), "tickers": json.dumps(["PART"]),
         "former_names": json.dumps([])},
        {"cik": CIK_FEW, "name": "Few Co", "sic": "7372", "sic_desc": "Software",
         "exchanges": json.dumps(["NYSE"]), "tickers": json.dumps(["FEWY"]),
         "former_names": json.dumps([])},
    ])
    return root


# --------------------------------------------------------------------------------------------------- #
# 1. Covered US name → full leg set, canonical spellings                                               #
# --------------------------------------------------------------------------------------------------- #
def test_covered_us_name_resolves_all_legs_with_canonical_spellings(lake: Path) -> None:
    s = Store(lake)
    li, source, obs, kts = pit_line_items(s, TickerIdentity("FULL", "US"), AS_OF)
    # 4 flows + 7 instants + earnings_stability = EXACTLY 12 keys for a fully-covered name
    # (market_cap_gbp/dividend_yield are the API's Gap-2 enrichment, never produced here).
    expected = {
        "net_income", "total_revenue", "gross_profit", "cash_flow_ops",
        "total_equity", "total_assets", "total_liabilities", "current_assets",
        "current_liabilities", "total_debt", "shares_outstanding", "earnings_stability",
    }
    assert len(li) >= 12
    # exact set equality — catches a MISSING leg AND a spuriously-produced extra leg (e.g. a real
    # LINE_ITEMS key that leaked in, which a `<= LINE_ITEMS` subset check alone would pass).
    assert set(li) == expected
    # every key is a real LINE_ITEMS member (canonical snake_case) — redundant with the equality but
    # documents the contract-vocabulary constraint explicitly.
    assert set(li) <= set(LINE_ITEMS)
    # the enriched legs are NOT produced here
    assert "market_cap_gbp" not in li
    assert "dividend_yield" not in li
    # values are the resolved facts
    assert li["net_income"] == 110.0
    assert li["total_revenue"] == 1000.0
    assert li["total_equity"] == 500.0
    assert li["shares_outstanding"] == 50.0
    assert li["total_debt"] == 250.0   # LongTermDebt, the 3rd select-fallback
    assert source == SOURCE_PIT_EDGAR
    assert obs is not None and kts is not None


def test_source_is_pit_edgar_only_when_a_leg_resolved(lake: Path) -> None:
    """A covered name stamps pit-edgar; a CIK that exists but is read BEFORE anything is knowable
    stamps None (a miss), not a fabricated source over an empty dict."""
    s = Store(lake)
    _, source, _, _ = pit_line_items(s, TickerIdentity("FULL", "US"), AS_OF)
    assert source == SOURCE_PIT_EDGAR
    # before any fact is knowable → empty → None everywhere
    before = _ms(2020, 1, 1)
    li, src, obs, kts = pit_line_items(s, TickerIdentity("FULL", "US"), before)
    assert li == {} and src is None and obs is None and kts is None


def test_observation_ts_is_net_income_period_end_in_utc_ms(lake: Path) -> None:
    """observation_ts is the period_end of the representative (net_income) leg, midnight-UTC ms.
    FULL's latest net-income annual ends 2023-12-31 → 2023-12-31T00:00:00Z."""
    s = Store(lake)
    _, _, obs, _ = pit_line_items(s, TickerIdentity("FULL", "US"), AS_OF)
    expected = int(datetime(2023, 12, 31, tzinfo=timezone.utc).timestamp() * 1000)
    assert obs == expected


def test_knowledge_ts_is_max_across_chosen_legs(lake: Path) -> None:
    """knowledge_ts is the max knowledge_ts across chosen legs that report one. Every FULL leg here is
    knowable at the FY2023 10-K instant (2024-02-16), so the max is that instant."""
    s = Store(lake)
    _, _, _, kts = pit_line_items(s, TickerIdentity("FULL", "US"), AS_OF)
    assert kts == _ms(2024, 2, 16)


# --------------------------------------------------------------------------------------------------- #
# 2. Non-US → {} fail-closed                                                                           #
# --------------------------------------------------------------------------------------------------- #
def test_lse_name_is_fail_closed_empty(lake: Path) -> None:
    """A non-US (LSE) identity returns ({}, None, None, None) immediately — no EDGAR, no Yahoo."""
    s = Store(lake)
    assert pit_line_items(s, TickerIdentity("FULL", "LSE"), AS_OF) == ({}, None, None, None)


def test_unknown_us_symbol_is_fail_closed_empty(lake: Path) -> None:
    """A US symbol absent from ticker_history resolves to no CIK → fail-closed {}."""
    s = Store(lake)
    assert pit_line_items(s, TickerIdentity("ZZZZ", "US"), AS_OF) == ({}, None, None, None)


def test_cold_lake_is_fail_closed_empty(tmp_path: Path) -> None:
    """A cold lake (no files) → fail-closed {} for any name (the store degrades, the contract too)."""
    cold = tmp_path / "cold"
    cold.mkdir()
    s = Store(cold)
    assert pit_line_items(s, TickerIdentity("FULL", "US"), AS_OF) == ({}, None, None, None)


# --------------------------------------------------------------------------------------------------- #
# 3. Missing leg omitted, never 0                                                                      #
# --------------------------------------------------------------------------------------------------- #
def test_missing_leg_is_omitted_not_zero(lake: Path) -> None:
    """PART has no GrossProfit fact → gross_profit is ABSENT from the dict (not 0). A fabricated 0
    would corrupt any ratio reading it; the factor NaN-excludes a missing key instead."""
    s = Store(lake)
    li, source, _, _ = pit_line_items(s, TickerIdentity("PART", "US"), AS_OF)
    assert "gross_profit" not in li             # absent...
    assert li.get("gross_profit") is None       # ...so .get is None, never 0
    assert li["net_income"] == 110.0            # the legs it DOES have still resolve
    assert source == SOURCE_PIT_EDGAR


def test_genuine_zero_value_is_preserved_not_dropped(tmp_path: Path) -> None:
    """The fail-closed omission drops a None-valued leg but MUST keep a genuine 0.0 — a debt-free
    company reports total_debt = 0, and dropping it (a falsy-filter bug) would wrongly omit a real
    fact. This pins `if v is not None` (not `if v`), the property the tautological all-not-None check
    could not catch.
    """
    root = tmp_path / "zero"
    root.mkdir()
    k = _ms(2024, 2, 16)
    # net_income (so the name resolves a leg) + a genuine zero total_debt instant.
    _write_facts(root, 600, [
        _annual(600, "NetIncomeLoss", 2023, 110.0, k),
        _instant(600, "LongTermDebt", "2023-12-31", 0.0, k),
    ])
    _write_ticker_history(root, [
        {"cik": 600, "ticker": "ZERO", "valid_from": date(2015, 1, 1), "valid_to": None},
    ])
    s = Store(root)
    li, _, _, _ = pit_line_items(s, TickerIdentity("ZERO", "US"), AS_OF)
    assert "total_debt" in li            # a genuine 0 is NOT dropped...
    assert li["total_debt"] == 0.0       # ...and is the real 0, not coerced away
    assert li["net_income"] == 110.0


# --------------------------------------------------------------------------------------------------- #
# 4. earnings_stability                                                                                #
# --------------------------------------------------------------------------------------------------- #
def test_earnings_stability_none_with_fewer_than_three_annuals(lake: Path) -> None:
    """FEWY has only 2 net-income annuals → earnings_stability is None (omitted from the dict)."""
    s = Store(lake)
    assert earnings_stability(s, CIK_FEW, AS_OF) is None
    li, _, _, _ = pit_line_items(s, TickerIdentity("FEWY", "US"), AS_OF)
    assert "earnings_stability" not in li


def test_earnings_stability_positive_for_steady_series(lake: Path) -> None:
    """FULL's net income is 90/100/110 (FY21/22/23) — a steady, growing series → a positive,
    sizeable inverse-CV. Mean 100, population stddev sqrt(200/3)≈8.165 → ≈12.25."""
    s = Store(lake)
    es = earnings_stability(s, CIK_FULL, AS_OF)
    assert es is not None
    assert es > 0
    # mean(90,100,110)=100; population var = ((−10)²+0²+(10)²)/3 = 200/3; std ≈ 8.165; 100/8.165 ≈ 12.247
    assert es == pytest.approx(100.0 / (200.0 / 3.0) ** 0.5, rel=1e-9)
    assert 12.0 < es < 12.5


def test_earnings_stability_none_when_stddev_zero(lake: Path, tmp_path: Path) -> None:
    """A perfectly flat earnings series (zero stddev) → None (the inverse-CV would divide by zero)."""
    flat_root = tmp_path / "flat"
    flat_root.mkdir()
    k1, k2, k3 = _ms(2022, 2, 16), _ms(2023, 2, 16), _ms(2024, 2, 16)
    _write_facts(flat_root, 777, [
        _annual(777, "NetIncomeLoss", 2021, 100.0, k1),
        _annual(777, "NetIncomeLoss", 2022, 100.0, k2),
        _annual(777, "NetIncomeLoss", 2023, 100.0, k3),
    ])
    s = Store(flat_root)
    assert earnings_stability(s, 777, AS_OF) is None


def test_earnings_stability_uses_only_annuals_at_or_before_as_of(lake: Path, tmp_path: Path) -> None:
    """A future net-income annual (knowledge_ts after as_of) must NOT enter the stability window —
    PIT-safety flows through the store. With FY2024 knowable only in 2025, an as_of in 2024 sees just
    FY21/22/23 (3 points), and a value identical to the all-history read at AS_OF."""
    root = tmp_path / "pit"
    root.mkdir()
    facts = _full_name_facts(900)
    # add a FY2024 net-income annual that is only knowable in 2025 (after AS_OF)
    facts.append(_annual(900, "NetIncomeLoss", 2024, 999.0, _ms(2025, 2, 16)))
    _write_facts(root, 900, facts)
    _write_ticker_history(root, [
        {"cik": 900, "ticker": "PITN", "valid_from": date(2015, 1, 1), "valid_to": None},
    ])
    s = Store(root)
    es_asof = earnings_stability(s, 900, AS_OF)             # FY2024 not yet knowable → 90/100/110
    assert es_asof == pytest.approx(100.0 / (200.0 / 3.0) ** 0.5, rel=1e-9)
    es_future = earnings_stability(s, 900, _ms(2025, 6, 1))  # now FY2024=999 enters the window
    # pin the EXACT 4-point population inverse-CV (90,100,110,999): mean 324.75, pop-std ≈389.34 →
    # ≈0.834. A directional `!= es_asof` alone wouldn't catch a wrong tail-selection that still differs.
    assert es_future == pytest.approx(0.8340982228254361, rel=1e-9)


# --------------------------------------------------------------------------------------------------- #
# 5. TTM preferred over annual for flows                                                               #
# --------------------------------------------------------------------------------------------------- #
def test_ttm_preferred_over_annual_for_flows(tmp_path: Path) -> None:
    """When both a TTM (4 consecutive quarters) and an annual are knowable, a flow leg takes the TTM.

    Build net_income as four 2024 quarters (Q1..Q4, each knowable in 2024/early-2025) summing to 240,
    PLUS a FY2024 annual of 200. The TTM over the four quarters (240) must win over the annual (200).
    """
    root = tmp_path / "ttm"
    root.mkdir()
    # four consecutive 2024 quarters, each its own ~90-day duration fact
    quarters = [
        ("2024-01-01", "2024-03-31", 50.0, _ms(2024, 5, 1)),
        ("2024-04-01", "2024-06-30", 60.0, _ms(2024, 8, 1)),
        ("2024-07-01", "2024-09-30", 70.0, _ms(2024, 11, 1)),
        ("2024-10-01", "2024-12-31", 60.0, _ms(2025, 2, 1)),
    ]
    rows = [
        _fact(cik=500, concept="NetIncomeLoss", value=v, start=s0, end=e0, knowledge_ts=k,
              accession=f"Q-{e0}", form="10-Q", fp="Q")
        for (s0, e0, v, k) in quarters
    ]
    # a competing FY2024 annual at a DIFFERENT value, knowable same as Q4
    rows.append(_annual(500, "NetIncomeLoss", 2024, 200.0, _ms(2025, 2, 1)))
    _write_facts(root, 500, rows)
    _write_ticker_history(root, [
        {"cik": 500, "ticker": "TTMN", "valid_from": date(2015, 1, 1), "valid_to": None},
    ])
    s = Store(root)
    as_of = _ms(2025, 6, 1)
    point = ttm_or_annual(s, 500, "net_income", as_of)
    assert point is not None
    assert point["value"] == 240.0   # the TTM sum, NOT the 200 annual

    li, _, _, _ = pit_line_items(s, TickerIdentity("TTMN", "US"), as_of)
    assert li["net_income"] == 240.0


def test_ttm_or_annual_falls_back_to_annual_without_four_quarters(lake: Path) -> None:
    """A name with no consecutive-quarter coverage (only annuals) yields no TTM → the annual value.
    FULL has only annuals → net_income falls back to the latest annual (110)."""
    s = Store(lake)
    point = ttm_or_annual(s, CIK_FULL, "net_income", AS_OF)
    assert point is not None
    assert point["value"] == 110.0   # latest annual (no quarters → no TTM)


# --------------------------------------------------------------------------------------------------- #
# 6. PIT provenance — knowledge_ts of a TTM-resolved leg is NOT under-reported                         #
# --------------------------------------------------------------------------------------------------- #
def test_knowledge_ts_reflects_a_ttm_legs_true_availability(tmp_path: Path) -> None:
    """A TTM flow leg whose completing quarter is the LATEST-knowable fact must drive the bundle's
    knowledge_ts — it cannot be under-reported to an earlier instant.

    Regression for the metrics `ttm`/`with_derived_q4` knowledge_ts carry: the derived TTM point now
    carries `knowledge_ts = max(input quarters)`, so when net_income resolves via a TTM whose Q4 is
    knowable AFTER every balance-sheet instant, the bundle's max-knowledge_ts is that Q4 instant — not
    the older instants'. Without the carry the TTM point had no knowledge_ts, the max excluded it, and
    the seam advertised the bundle knowable too early (a look-ahead-adjacent provenance leak).
    """
    root = tmp_path / "ttmkts"
    root.mkdir()
    k_inst = _ms(2024, 5, 1)     # the balance-sheet instants are knowable here
    q4_kts = _ms(2025, 2, 1)     # the TTM's completing Q4 is knowable LATER
    quarters = [
        ("2024-01-01", "2024-03-31", 50.0, _ms(2024, 5, 1)),
        ("2024-04-01", "2024-06-30", 60.0, _ms(2024, 8, 1)),
        ("2024-07-01", "2024-09-30", 70.0, _ms(2024, 11, 1)),
        ("2024-10-01", "2024-12-31", 60.0, q4_kts),
    ]
    rows = [
        _fact(cik=700, concept="NetIncomeLoss", value=v, start=s0, end=e0, knowledge_ts=k,
              accession=f"Q-{e0}", form="10-Q", fp="Q")
        for (s0, e0, v, k) in quarters
    ]
    # an older balance-sheet instant (knowable k_inst, BEFORE the Q4)
    rows.append(_instant(700, "StockholdersEquity", "2024-09-30", 500.0, k_inst))
    _write_facts(root, 700, rows)
    _write_ticker_history(root, [
        {"cik": 700, "ticker": "TKTS", "valid_from": date(2015, 1, 1), "valid_to": None},
    ])
    s = Store(root)
    as_of = _ms(2025, 6, 1)
    li, source, obs, kts = pit_line_items(s, TickerIdentity("TKTS", "US"), as_of)
    assert li["net_income"] == 240.0           # resolved via the TTM
    assert source == SOURCE_PIT_EDGAR
    # the bundle's knowledge_ts is the LATER Q4 instant (the TTM leg now contributes it), NOT k_inst
    assert kts == q4_kts


def test_earnings_stability_flat_fractional_series_is_none(tmp_path: Path) -> None:
    """Equal-but-FRACTIONAL annual net income (a converted-currency ADR) must read as flat → None,
    not a ~1e15 outlier. The relative-tolerance guard catches the float-rounding case a bare
    `stddev == 0` check would miss (mean rounds, so each residual is ~1e-6 not exactly 0)."""
    root = tmp_path / "frac"
    root.mkdir()
    k1, k2, k3 = _ms(2022, 2, 16), _ms(2023, 2, 16), _ms(2024, 2, 16)
    v = 7_777_777_777.77   # equal every year, but not exactly representable in float64
    _write_facts(root, 800, [
        _annual(800, "NetIncomeLoss", 2021, v, k1),
        _annual(800, "NetIncomeLoss", 2022, v, k2),
        _annual(800, "NetIncomeLoss", 2023, v, k3),
    ])
    s = Store(root)
    assert earnings_stability(s, 800, AS_OF) is None


def test_earnings_stability_low_but_real_variance_scores_normally(tmp_path: Path) -> None:
    """A genuinely low-but-REAL earnings dispersion is NOT flattened to None — only the
    float-rounding-flat case is. 1e9, 1e9+1000, 1e9-1000 has a real stddev → a large finite score."""
    root = tmp_path / "lowvar"
    root.mkdir()
    k1, k2, k3 = _ms(2022, 2, 16), _ms(2023, 2, 16), _ms(2024, 2, 16)
    _write_facts(root, 810, [
        _annual(810, "NetIncomeLoss", 2021, 1_000_000_000.0, k1),
        _annual(810, "NetIncomeLoss", 2022, 1_000_001_000.0, k2),
        _annual(810, "NetIncomeLoss", 2023, 999_999_000.0, k3),
    ])
    s = Store(root)
    es = earnings_stability(s, 810, AS_OF)
    assert es is not None and es > 0     # a real (large) inverse-CV, not None
