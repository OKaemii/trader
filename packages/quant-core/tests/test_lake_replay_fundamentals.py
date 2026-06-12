"""LakePitFundamentals — the backtest-replay PIT source read straight from the lake (epic Task 12).

Proves the contract end-to-end over a SYNTHETIC lake built with the real Task-3 ``SCHEMA`` (so the
on-disk column shape the harvester writes flows through ``store`` + ``metrics`` + ``contract`` +
``replay`` with NO mocks of the read engine) — this is the same fixture style as the Task-5/6 suites.
The market-cap PRICE leg is the one injected seam (the bars live in the separate warehouse snapshot,
not the lake), so it is a recorded callable; everything else is real DuckDB over real Parquet.

The behaviours pinned (the whole replay contract):
  1. A replay step reads as-of LINE ITEMS for a covered US name from the lake (the canonical 12 legs).
  2. PER-STEP as-of: an earlier as_of sees an earlier knowledge horizon; a later as_of sees more.
  3. The look-ahead guard flows through from the store — a fact knowable only in the future is unseen.
  4. Market cap is computed price×shares×fx off the INJECTED bars read (GBP-identity for an LSE name;
     DROPPED for a USD name under the default FX policy — the documented USD-FX-series gap), and
     OVERRIDES any stale value; a name with no shares drops it WITHOUT touching the bars read.
  5. Cold/empty lake → ``{}`` per name (no crash); a non-US or unknown or non-equity ticker → absent.
  6. ``LakePitFundamentals`` is a structural ``FundamentalsAsOf`` (drops into the same seam), and the
     FB→META rename is applied at the ticker boundary so the legacy symbol resolves the surviving CIK.

pyarrow + duckdb are the ``quant-core[lake]`` extra — the docker gate installs ``[lake]`` so this
suite runs there; locally it ``importorskip``s both so the rest of the quant-core suite still
collects where they are absent.
"""
from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")
pytest.importorskip("duckdb")

from quant_core.fundamentals.contract import FundamentalsAsOf, SOURCE_PIT_EDGAR  # noqa: E402
from quant_core.fundamentals.lake.replay import LakePitFundamentals  # noqa: E402
from quant_core.fundamentals.lake.schema import SCHEMA  # noqa: E402
from quant_core.fundamentals.lake.store import Store  # noqa: E402

# Identity tables the store reads by name — same on-disk shape the harvester writes (Task-5/6 suites).
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

CIK_AAPL = 320193     # a fully-covered US name (every leg) → AAPL_US_EQ
CIK_META = 1326801    # the FB→META rename target (legacy FB_US_EQ must resolve here)


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


# Knowledge instants: FY2021/22/23 10-Ks become knowable in early 2022/23/24 respectively.
K23, K22, K21 = _ms(2024, 2, 16), _ms(2023, 2, 16), _ms(2022, 2, 16)
# A clean as-of after the FY2023 10-K is knowable.
AS_OF = _ms(2024, 6, 1)


def _full_name_facts(cik: int) -> list[dict]:
    """Every leg the contract assembles, for a fully-covered US name (the Task-6 fixture shape):
    3 net-income annuals (so earnings_stability is defined) + the other flows + all instants."""
    rows: list[dict] = [
        _annual(cik, "NetIncomeLoss", 2021, 90.0, K21),
        _annual(cik, "NetIncomeLoss", 2022, 100.0, K22),
        _annual(cik, "NetIncomeLoss", 2023, 110.0, K23),
        _annual(cik, "Revenues", 2023, 1000.0, K23),
        _annual(cik, "GrossProfit", 2023, 400.0, K23),
        _annual(cik, "NetCashProvidedByUsedInOperatingActivities", 2023, 150.0, K23),
        _instant(cik, "StockholdersEquity", "2023-12-31", 500.0, K23),
        _instant(cik, "Assets", "2023-12-31", 1500.0, K23),
        _instant(cik, "Liabilities", "2023-12-31", 1000.0, K23),
        _instant(cik, "AssetsCurrent", "2023-12-31", 600.0, K23),
        _instant(cik, "LiabilitiesCurrent", "2023-12-31", 300.0, K23),
        _instant(cik, "LongTermDebt", "2023-12-31", 250.0, K23),
        _instant(cik, "EntityCommonStockSharesOutstanding", "2023-12-31", 50.0, K23,
                 taxonomy="dei", unit="shares"),
    ]
    return rows


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
    """A synthetic lake with a fully-covered US name (AAPL) + the META rename target, keyed under the
    BARE symbols the T212 adapter produces (AAPL_US_EQ → AAPL, FB_US_EQ → applyRename → META)."""
    root = tmp_path / "lake"
    root.mkdir()
    _write_facts(root, CIK_AAPL, _full_name_facts(CIK_AAPL))
    _write_facts(root, CIK_META, _full_name_facts(CIK_META))
    _write_ticker_history(root, [
        {"cik": CIK_AAPL, "ticker": "AAPL", "valid_from": date(2010, 1, 1), "valid_to": None},
        {"cik": CIK_META, "ticker": "META", "valid_from": date(2012, 5, 18), "valid_to": None},
    ])
    _write_entities(root, [
        {"cik": CIK_AAPL, "name": "Apple Inc", "sic": "3571", "sic_desc": "Computers",
         "exchanges": json.dumps(["NASDAQ"]), "tickers": json.dumps(["AAPL"]),
         "former_names": json.dumps([])},
        {"cik": CIK_META, "name": "Meta Platforms", "sic": "7370", "sic_desc": "Services",
         "exchanges": json.dumps(["NASDAQ"]), "tickers": json.dumps(["META"]),
         "former_names": json.dumps([{"name": "Facebook", "from": "2012-05-18", "to": "2022-06-09"}])},
    ])
    return root


class _BarsRecorder:
    """Records every (ticker, as_of_ms) the market-cap price leg asks for and returns a fixed close.
    Stands in for the warehouse bars read the host injects — proves the reader passes the ORIGINAL
    T212 ticker (post-rename) and the step's as_of, and that the close drives the identity."""

    def __init__(self, close_by_ticker: dict[str, float]):
        self._close = dict(close_by_ticker)
        self.calls: list[tuple[str, int]] = []

    def __call__(self, ticker: str, as_of_ms: int):
        self.calls.append((ticker, as_of_ms))
        return self._close.get(ticker)


# --------------------------------------------------------------------------------------------------- #
# 1. A replay step reads as-of line items from the lake (the headline)                                 #
# --------------------------------------------------------------------------------------------------- #
def test_replay_step_reads_as_of_line_items_for_covered_us_name(lake: Path) -> None:
    """A covered US name (AAPL_US_EQ) resolves the full 12-leg as-of line-item set from the lake,
    keyed by the ORIGINAL T212 ticker. No FX/bars needed for the line items themselves."""
    prov = LakePitFundamentals(Store(lake))
    out = asyncio.run(prov.fetch_many(["AAPL_US_EQ"], AS_OF))
    assert "AAPL_US_EQ" in out
    f = out["AAPL_US_EQ"]
    # the canonical legs the contract assembles (market_cap_gbp absent — no shares×price×fx here)
    assert f["net_income"] == 110.0
    assert f["total_revenue"] == 1000.0
    assert f["total_equity"] == 500.0
    assert f["shares_outstanding"] == 50.0
    assert f["total_debt"] == 250.0
    assert "earnings_stability" in f          # 3 net-income annuals ⇒ defined
    # no bars injected ⇒ market cap dropped (never fabricated)
    assert "market_cap_gbp" not in f


def test_uncovered_name_absent_never_fabricated(lake: Path) -> None:
    """A US ticker absent from the lake (no CIK) is ABSENT from the map — the forward-only degrade."""
    prov = LakePitFundamentals(Store(lake))
    out = asyncio.run(prov.fetch_many(["ZZZZ_US_EQ", "AAPL_US_EQ"], AS_OF))
    assert "ZZZZ_US_EQ" not in out
    assert "AAPL_US_EQ" in out


# --------------------------------------------------------------------------------------------------- #
# 2 + 3. Per-step as-of + the look-ahead guard                                                         #
# --------------------------------------------------------------------------------------------------- #
def test_per_step_as_of_sees_only_what_is_knowable(lake: Path) -> None:
    """The reader re-resolves per step: an as_of between the FY2022 and FY2023 10-Ks sees net_income
    110 NOT yet — only 100 (FY2022, the latest knowable annual); a later as_of sees 110."""
    prov = LakePitFundamentals(Store(lake))
    between = asyncio.run(prov.fetch_many(["AAPL_US_EQ"], _ms(2023, 6, 1)))  # FY2023 not yet knowable
    after = asyncio.run(prov.fetch_many(["AAPL_US_EQ"], AS_OF))               # FY2023 knowable
    assert between["AAPL_US_EQ"]["net_income"] == 100.0
    assert after["AAPL_US_EQ"]["net_income"] == 110.0


def test_look_ahead_guard_before_any_filing_is_empty(lake: Path) -> None:
    """An as_of before AAPL's earliest knowable fact → the name is absent (nothing knowable as-of)."""
    prov = LakePitFundamentals(Store(lake))
    out = asyncio.run(prov.fetch_many(["AAPL_US_EQ"], _ms(2015, 1, 1)))
    assert out == {}


# --------------------------------------------------------------------------------------------------- #
# 4. Market cap (price × shares × fx), off the INJECTED bars read                                      #
# --------------------------------------------------------------------------------------------------- #
def test_market_cap_computed_via_injected_bars_and_identity_fx(lake: Path) -> None:
    """Market cap is COMPUTED price×shares×fx off the INJECTED bars read and OVERRIDES any stored
    value. The lake only resolves US CIKs (LSE is fail-closed), so the GBP-native market-cap branch
    (fx = 1.0) is exercised here by injecting an identity FX — isolating the IDENTITY arithmetic + the
    injected-bars wiring (the default per-currency FX policy is tested separately below). The bars
    read must receive the ORIGINAL T212 ticker + the step's as_of."""
    bars = _BarsRecorder({"AAPL_US_EQ": 6.5})
    prov = LakePitFundamentals(Store(lake), bars_close_as_of=bars, fx_to_gbp=lambda ccy: 1.0)
    out = asyncio.run(prov.fetch_many(["AAPL_US_EQ"], AS_OF))
    assert out["AAPL_US_EQ"]["market_cap_gbp"] == 6.5 * 50.0 * 1.0
    assert bars.calls == [("AAPL_US_EQ", AS_OF)]


def test_market_cap_dropped_for_usd_name_under_default_fx_policy(lake: Path) -> None:
    """Under the DEFAULT FX policy a USD name has no GBP rate (the documented USD-FX-series gap), so
    its market cap is DROPPED even with a real bars close — never fabricated. The Value legs
    NaN-exclude it. This is the limitation carried forward unchanged from the warehouse path."""
    bars = _BarsRecorder({"AAPL_US_EQ": 300.0})
    prov = LakePitFundamentals(Store(lake), bars_close_as_of=bars)  # default fx (GBP→1, USD→None)
    out = asyncio.run(prov.fetch_many(["AAPL_US_EQ"], AS_OF))
    assert "market_cap_gbp" not in out["AAPL_US_EQ"]
    assert bars.calls == [("AAPL_US_EQ", AS_OF)]   # the price leg WAS asked (shares present)


def test_market_cap_computed_for_usd_name_with_injected_fx(lake: Path) -> None:
    """With an injected USD→GBP rate (a future historical FX series), a USD name's market cap becomes
    computable — proving the gap is purely the missing FX series, not the arithmetic."""
    bars = _BarsRecorder({"AAPL_US_EQ": 300.0})
    prov = LakePitFundamentals(
        Store(lake), bars_close_as_of=bars,
        fx_to_gbp=lambda ccy: 0.8 if ccy == "USD" else (1.0 if ccy == "GBP" else None),
    )
    out = asyncio.run(prov.fetch_many(["AAPL_US_EQ"], AS_OF))
    assert out["AAPL_US_EQ"]["market_cap_gbp"] == 300.0 * 50.0 * 0.8


def test_market_cap_skipped_when_no_shares_without_touching_bars(tmp_path: Path) -> None:
    """A covered name with NO shares_outstanding fact drops market cap WITHOUT touching the bars read
    (the hot-path short-circuit) — and never fabricates one."""
    root = tmp_path / "noshares"
    root.mkdir()
    # net_income (so a leg resolves) but NO EntityCommonStockSharesOutstanding.
    _write_facts(root, CIK_AAPL, [_annual(CIK_AAPL, "NetIncomeLoss", 2023, 110.0, K23)])
    _write_ticker_history(root, [
        {"cik": CIK_AAPL, "ticker": "AAPL", "valid_from": date(2010, 1, 1), "valid_to": None},
    ])
    bars = _BarsRecorder({"AAPL_US_EQ": 300.0})
    prov = LakePitFundamentals(Store(root), bars_close_as_of=bars, fx_to_gbp=lambda ccy: 1.0)
    out = asyncio.run(prov.fetch_many(["AAPL_US_EQ"], AS_OF))
    assert out["AAPL_US_EQ"]["net_income"] == 110.0
    assert "market_cap_gbp" not in out["AAPL_US_EQ"]
    assert bars.calls == []   # short-circuit: the bars read was never asked (no shares)


# --------------------------------------------------------------------------------------------------- #
# 5. Cold lake / non-US / non-equity ticker degrade                                                    #
# --------------------------------------------------------------------------------------------------- #
def test_cold_lake_degrades_to_empty_per_name(tmp_path: Path) -> None:
    """A cold lake (no files) → {} for every name (the store degrades, the reader too) — no crash."""
    cold = tmp_path / "cold"
    cold.mkdir()
    prov = LakePitFundamentals(Store(cold))
    out = asyncio.run(prov.fetch_many(["AAPL_US_EQ", "MSFT_US_EQ"], AS_OF))
    assert out == {}


def test_lse_name_is_fail_closed_absent(lake: Path) -> None:
    """A non-US (LSE) ticker is fail-closed in the lake (no EDGAR, no Yahoo) → absent from the map."""
    prov = LakePitFundamentals(Store(lake))
    out = asyncio.run(prov.fetch_many(["HSBAl_EQ", "AAPL_US_EQ"], AS_OF))
    assert "HSBAl_EQ" not in out
    assert "AAPL_US_EQ" in out


def test_non_equity_ticker_is_uncovered_not_a_crash(lake: Path) -> None:
    """A non-equity ticker form (a benchmark index `^GSPC`, a malformed string) is not a US/LSE equity
    — the adapter rejects it; the reader treats it as uncovered (absent), never crashing the step."""
    prov = LakePitFundamentals(Store(lake))
    out = asyncio.run(prov.fetch_many(["^GSPC", "", "NOTATICKER", "AAPL_US_EQ"], AS_OF))
    assert set(out) == {"AAPL_US_EQ"}   # only the real equity resolves; the rest degrade silently


# --------------------------------------------------------------------------------------------------- #
# 6. Protocol conformance + the FB→META rename at the boundary                                         #
# --------------------------------------------------------------------------------------------------- #
def test_satisfies_fundamentals_as_of_protocol(lake: Path) -> None:
    """LakePitFundamentals is a structural FundamentalsAsOf (fetch_many/fetch/source_for), so it drops
    into the same seam PitFundamentalsBarsReader wraps."""
    prov = LakePitFundamentals(Store(lake))
    assert isinstance(prov, FundamentalsAsOf)
    assert prov.source_for("AAPL_US_EQ") == SOURCE_PIT_EDGAR


def test_fetch_single_name_convenience(lake: Path) -> None:
    """fetch(ticker, as_of) is the single-name convenience over fetch_many."""
    prov = LakePitFundamentals(Store(lake))
    f = asyncio.run(prov.fetch("AAPL_US_EQ", AS_OF))
    assert f["net_income"] == 110.0
    # an uncovered single name → {}
    assert asyncio.run(prov.fetch("ZZZZ_US_EQ", AS_OF)) == {}


def test_legacy_fb_ticker_resolves_meta_via_rename(lake: Path) -> None:
    """The FB→META rename is applied at the ticker boundary: a legacy ``FB_US_EQ`` resolves the
    surviving META CIK in the lake (history continuous across the rebrand), keyed by the ORIGINAL
    ``FB_US_EQ`` the panel still carries."""
    prov = LakePitFundamentals(Store(lake))
    out = asyncio.run(prov.fetch_many(["FB_US_EQ"], AS_OF))
    assert "FB_US_EQ" in out                       # resolved via apply_rename → META's CIK
    assert out["FB_US_EQ"]["net_income"] == 110.0  # META's facts (the surviving entity)
