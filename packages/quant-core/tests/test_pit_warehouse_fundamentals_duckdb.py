"""Reconcile WarehousePitFundamentals' literal SQL against REAL DuckDB (PIT-fundamentals epic Task 15).

Task 13 proved the reader's pivot/restatement/`_prev`/market-cap LOGIC over a faithful FAKE connection
(`test_pit_warehouse_fundamentals.py`) because the gate didn't install DuckDB then. Task 15 closes that
gap exactly as `WarehouseBarsReader`'s SQL is reconciled against real snapshotter output: it seeds an
in-memory DuckDB with `fundamentals` + `bars` tables shaped like the warehouse snapshot, registers them
as the views the reader expects, and asserts the SAME contract holds when the REAL SQL strings run —
proving the literal `_SELECT_AS_OF` / `_SELECT_CLOSE_AS_OF` are valid DuckDB and have the bi-temporal
semantics the fake stood in for.

DuckDB is the `quant-core[warehouse]` optional extra. The python gate installs it transitively via
backtest-engine's requirements.txt (duckdb==1.1.3) before the quant-core suite runs; a bare local run
without the extra skips this module (the fake-connection suite still covers the logic everywhere).
"""
import asyncio

import pytest

duckdb = pytest.importorskip("duckdb")

from quant_core.fundamentals.warehouse import WarehousePitFundamentals  # noqa: E402


# Same fixture timestamps as the fake-connection suite, so the two prove the same scenarios.
FY2018 = 1_546_300_000_000
FY2019 = 1_577_800_000_000
KNOWN_2018 = 1_551_000_000_000
KNOWN_2019 = 1_582_000_000_000
AS_OF_AFTER_2019 = 1_590_000_000_000
AS_OF_BETWEEN = 1_560_000_000_000


def _con(fact_rows=None, bar_rows=None):
    """An in-memory DuckDB with `fundamentals` + `bars` views over seeded rows, shaped like the
    snapshot Parquet (the columns the reader's SQL references). Mirrors how a real WarehouseReader
    registers these as views — here we materialise tables and the SQL binds against them identically."""
    con = duckdb.connect(":memory:")
    # Column set = the warehouse `fundamentals` snapshot the reader selects from (0009_fundamentals.sql).
    con.execute(
        """
        CREATE TABLE fundamentals (
          instrument_id BIGINT, metric VARCHAR, observation_ts BIGINT, knowledge_ts BIGINT,
          dim_signature VARCHAR, value DOUBLE, is_superseded BOOLEAN
        )
        """
    )
    con.execute(
        """
        CREATE TABLE bars (
          ticker VARCHAR, interval VARCHAR, observation_ts BIGINT, knowledge_ts BIGINT,
          close DOUBLE, is_superseded BOOLEAN
        )
        """
    )
    for r in fact_rows or []:
        con.execute(
            "INSERT INTO fundamentals VALUES (?, ?, ?, ?, ?, ?, ?)",
            [r["instrument_id"], r["metric"], r["observation_ts"], r["knowledge_ts"],
             r.get("dim_signature", ""), r["value"], r.get("is_superseded", False)],
        )
    for b in bar_rows or []:
        con.execute(
            "INSERT INTO bars VALUES (?, ?, ?, ?, ?, ?)",
            [b["ticker"], b.get("interval", "daily"), b["observation_ts"], b["knowledge_ts"],
             b["close"], b.get("is_superseded", False)],
        )
    return con


def _resolver(mapping):
    return lambda ticker, _as_of: mapping.get(ticker)


def _aapl_facts(instrument_id=1):
    return [
        {"instrument_id": instrument_id, "metric": "total_assets", "observation_ts": FY2018, "knowledge_ts": KNOWN_2018, "value": 1000.0},
        {"instrument_id": instrument_id, "metric": "total_assets", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 1100.0},
        {"instrument_id": instrument_id, "metric": "total_equity", "observation_ts": FY2018, "knowledge_ts": KNOWN_2018, "value": 400.0},
        {"instrument_id": instrument_id, "metric": "total_equity", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 420.0},
        {"instrument_id": instrument_id, "metric": "net_income", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 90.0},
        {"instrument_id": instrument_id, "metric": "shares_outstanding", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 10.0},
    ]


def test_real_duckdb_as_of_pivot_latest_plus_prev():
    """The REAL _SELECT_AS_OF over DuckDB → latest annual per metric + the `_prev` YoY value."""
    con = _con(_aapl_facts())
    wh = WarehousePitFundamentals(con, resolve_instrument=_resolver({"AAPL_US_EQ": 1}))
    f = asyncio.run(wh.fetch_many(["AAPL_US_EQ"], AS_OF_AFTER_2019))["AAPL_US_EQ"]
    assert f["total_assets"] == 1100.0
    assert f["total_equity"] == 420.0
    assert f["net_income"] == 90.0
    assert f["total_assets_prev"] == 1000.0
    assert f["total_equity_prev"] == 400.0
    assert "net_income_prev" not in f


def test_real_duckdb_no_look_ahead():
    """As-of BETWEEN the two filings → the `knowledge_ts <= ?` clause in the REAL SQL hides FY2019."""
    con = _con(_aapl_facts())
    wh = WarehousePitFundamentals(con, resolve_instrument=_resolver({"AAPL_US_EQ": 1}))
    f = asyncio.run(wh.fetch_many(["AAPL_US_EQ"], AS_OF_BETWEEN))["AAPL_US_EQ"]
    assert f["total_assets"] == 1000.0      # FY2018, the only knowable observation
    assert "total_assets_prev" not in f     # FY2019 not yet knowable → no prior year


def test_real_duckdb_restatement_original_vs_restated():
    """A later restatement of FY2019 total_assets: an as-of before its knowledge_ts returns the
    first-print; after, the restated value — the as-of ROW_NUMBER pick over real DuckDB."""
    restated_known = AS_OF_AFTER_2019 + 5_000_000_000
    facts = _aapl_facts() + [
        {"instrument_id": 1, "metric": "total_assets", "observation_ts": FY2019, "knowledge_ts": restated_known, "value": 1150.0},
    ]
    con = _con(facts)
    wh = WarehousePitFundamentals(con, resolve_instrument=_resolver({"AAPL_US_EQ": 1}))
    before = asyncio.run(wh.fetch_many(["AAPL_US_EQ"], AS_OF_AFTER_2019))
    after = asyncio.run(wh.fetch_many(["AAPL_US_EQ"], restated_known + 1_000_000_000))
    assert before["AAPL_US_EQ"]["total_assets"] == 1100.0   # first-print
    assert after["AAPL_US_EQ"]["total_assets"] == 1150.0     # restated


def test_real_duckdb_segment_facts_excluded():
    """A dimensioned (segment) fact must NOT enter the consolidated line items — the `dim_signature
    = ''` clause in the REAL SQL filters it (else double-count). The undimensioned value wins."""
    facts = [
        {"instrument_id": 1, "metric": "total_revenue", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 500.0, "dim_signature": ""},
        {"instrument_id": 1, "metric": "total_revenue", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 200.0, "dim_signature": "segment=us"},
    ]
    con = _con(facts)
    wh = WarehousePitFundamentals(con, resolve_instrument=_resolver({"AAPL_US_EQ": 1}))
    f = asyncio.run(wh.fetch_many(["AAPL_US_EQ"], AS_OF_AFTER_2019))["AAPL_US_EQ"]
    assert f["total_revenue"] == 500.0      # consolidated only; the segment row excluded


def test_real_duckdb_market_cap_lse_gbp_computed():
    """_SELECT_CLOSE_AS_OF over real DuckDB → GBP (LSE) name market cap = price × shares × 1.0."""
    facts = [
        {"instrument_id": 2, "metric": "total_equity", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 50.0},
        {"instrument_id": 2, "metric": "shares_outstanding", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 4.0},
    ]
    bars = [{"ticker": "HSBAl_EQ", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "close": 6.5}]
    con = _con(facts, bars)
    wh = WarehousePitFundamentals(con, resolve_instrument=_resolver({"HSBAl_EQ": 2}))
    f = asyncio.run(wh.fetch_many(["HSBAl_EQ"], AS_OF_AFTER_2019))["HSBAl_EQ"]
    assert f["market_cap_gbp"] == pytest.approx(6.5 * 4.0 * 1.0)


def test_real_duckdb_market_cap_usd_with_injected_fx():
    """With an injected FX callable (the Task-15 path), a USD name's market cap becomes computable —
    the as-of close × shares × fx over real DuckDB."""
    facts = [
        {"instrument_id": 3, "metric": "shares_outstanding", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 10.0},
        {"instrument_id": 3, "metric": "net_income", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 5.0},
    ]
    bars = [{"ticker": "AAPL_US_EQ", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "close": 300.0}]
    con = _con(facts, bars)
    wh = WarehousePitFundamentals(
        con,
        resolve_instrument=_resolver({"AAPL_US_EQ": 3}),
        fx_to_gbp=lambda ccy: 0.8 if ccy == "USD" else (1.0 if ccy == "GBP" else None),
    )
    f = asyncio.run(wh.fetch_many(["AAPL_US_EQ"], AS_OF_AFTER_2019))["AAPL_US_EQ"]
    assert f["market_cap_gbp"] == pytest.approx(300.0 * 10.0 * 0.8)


def test_real_duckdb_market_cap_close_is_bi_temporal():
    """The close pick is bi-temporal: a later-revised close (higher knowledge_ts) is invisible before
    its knowledge_ts. As-of between the two close revisions uses the FIRST-print close, not the
    revision — `_SELECT_CLOSE_AS_OF`'s `knowledge_ts <= ?` over real DuckDB."""
    facts = [
        {"instrument_id": 2, "metric": "shares_outstanding", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 2.0},
    ]
    bars = [
        {"ticker": "HSBAl_EQ", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "close": 6.0},          # first print
        {"ticker": "HSBAl_EQ", "observation_ts": FY2019, "knowledge_ts": AS_OF_AFTER_2019 + 9_000_000_000, "close": 9.0},  # later revision
    ]
    con = _con(facts, bars)
    wh = WarehousePitFundamentals(con, resolve_instrument=_resolver({"HSBAl_EQ": 2}))
    f = asyncio.run(wh.fetch_many(["HSBAl_EQ"], AS_OF_AFTER_2019))["HSBAl_EQ"]
    assert f["market_cap_gbp"] == pytest.approx(6.0 * 2.0 * 1.0)   # first-print close, not the 9.0 revision


def test_real_duckdb_uncovered_name_absent():
    """An instrument with no fact ≤ as_of is absent (the forward-only degrade) — real DuckDB empty
    result, never a fabricated value."""
    con = _con(_aapl_facts())
    wh = WarehousePitFundamentals(con, resolve_instrument=_resolver({"AAPL_US_EQ": 1}))
    out = asyncio.run(wh.fetch_many(["AAPL_US_EQ"], FY2018 - 1))   # before the first filing
    assert out == {}


def test_real_duckdb_empty_fundamentals_view_degrades_to_empty():
    """A never-backfilled warehouse: the `fundamentals` view exists but holds zero rows → every name
    degrades to {} (no error). Proves the live warehouse pre-backfill read is honest, not a crash."""
    con = _con([])   # tables created, no rows inserted
    wh = WarehousePitFundamentals(con, resolve_instrument=_resolver({"AAPL_US_EQ": 1}))
    out = asyncio.run(wh.fetch_many(["AAPL_US_EQ"], AS_OF_AFTER_2019))
    assert out == {}
