"""WarehouseReader.get_fundamentals — the as-of fundamentals primitive over real DuckDB (Task 15).

Mirrors the bars as-of test pattern: seed an in-memory DuckDB `fundamentals` table shaped like the
snapshot, register it the way the reader does, and assert `get_fundamentals(instrument_ids, as_of_ms)`
returns ONLY rows whose `knowledge_ts <= as_of` (no look-ahead, in SQL), the latest revision per
logical fact, consolidated only. Also proves the never-backfilled warehouse degrades to {} rather than
raising (the live pre-backfill read).

DuckDB ships in backtest-engine's requirements (the warehouse reader's store); the gate installs it
before this suite runs. A bare local run without it skips the module.
"""
import pytest

duckdb = pytest.importorskip("duckdb")

from src.infrastructure.duckdb_reader import WarehouseReader   # noqa: E402


FY2018 = 1_546_300_000_000
FY2019 = 1_577_800_000_000
KNOWN_2018 = 1_551_000_000_000
KNOWN_2019 = 1_582_000_000_000
AS_OF_AFTER_2019 = 1_590_000_000_000
AS_OF_BETWEEN = 1_560_000_000_000


def _reader_with_fundamentals(rows):
    """A WarehouseReader whose `fundamentals` view is a seeded in-memory table (the other views stay
    the empty stubs the constructor registers when no Parquet exists). We point the reader at a
    non-existent dir so every table registers as an empty stub, then REPLACE the `fundamentals` stub
    with a real seeded table — exercising get_fundamentals' SQL against real rows."""
    reader = WarehouseReader(warehouse_dir="/nonexistent-warehouse-for-test")
    con = reader._con
    con.execute("DROP VIEW IF EXISTS fundamentals")
    con.execute(
        """
        CREATE TABLE fundamentals (
          instrument_id BIGINT, metric VARCHAR, observation_ts BIGINT, knowledge_ts BIGINT,
          dim_signature VARCHAR, value DOUBLE, is_superseded BOOLEAN
        )
        """
    )
    for r in rows:
        con.execute(
            "INSERT INTO fundamentals VALUES (?, ?, ?, ?, ?, ?, ?)",
            [r["instrument_id"], r["metric"], r["observation_ts"], r["knowledge_ts"],
             r.get("dim_signature", ""), r["value"], r.get("is_superseded", False)],
        )
    return reader


def _rows(instrument_id=1):
    return [
        {"instrument_id": instrument_id, "metric": "total_assets", "observation_ts": FY2018, "knowledge_ts": KNOWN_2018, "value": 1000.0},
        {"instrument_id": instrument_id, "metric": "total_assets", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 1100.0},
        {"instrument_id": instrument_id, "metric": "net_income", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 90.0},
    ]


def test_get_fundamentals_as_of_returns_only_knowable_rows():
    """As-of BETWEEN the two filings → only the FY2018 fact (knowledge_ts ≤ as_of); FY2019 (knowable
    later) is filtered out by the `knowledge_ts <= ?` clause."""
    reader = _reader_with_fundamentals(_rows())
    out = reader.get_fundamentals([1], AS_OF_BETWEEN)
    facts = out[1]
    metrics = {(r["metric"], r["observation_ts"]) for r in facts}
    assert ("total_assets", FY2018) in metrics
    assert ("total_assets", FY2019) not in metrics   # not yet knowable
    assert ("net_income", FY2019) not in metrics
    # No returned row may carry a knowledge_ts after the as-of.
    assert all(r["knowledge_ts"] <= AS_OF_BETWEEN for r in facts)
    reader.close()


def test_get_fundamentals_as_of_after_all_filings_returns_latest_per_fact():
    """As-of after both filings → the latest revision per logical fact; both annual total_assets
    observations are present (distinct observation_ts), plus net_income."""
    reader = _reader_with_fundamentals(_rows())
    out = reader.get_fundamentals([1], AS_OF_AFTER_2019)
    by_metric = {(r["metric"], r["observation_ts"]): r["value"] for r in out[1]}
    assert by_metric[("total_assets", FY2018)] == 1000.0
    assert by_metric[("total_assets", FY2019)] == 1100.0
    assert by_metric[("net_income", FY2019)] == 90.0
    reader.close()


def test_get_fundamentals_picks_latest_revision_per_logical_fact():
    """Two revisions of the SAME logical fact (same instrument/metric/observation_ts, different
    knowledge_ts) → the ROW_NUMBER as-of pick returns ONLY the latest knowable revision."""
    rows = _rows() + [
        {"instrument_id": 1, "metric": "total_assets", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019 + 1_000_000, "value": 1150.0},
    ]
    reader = _reader_with_fundamentals(rows)
    out = reader.get_fundamentals([1], AS_OF_AFTER_2019)
    fy2019 = [r for r in out[1] if r["metric"] == "total_assets" and r["observation_ts"] == FY2019]
    assert len(fy2019) == 1                 # exactly one row per logical fact
    assert fy2019[0]["value"] == 1150.0     # the latest revision
    reader.close()


def test_get_fundamentals_excludes_segment_dim_facts():
    """Dimensioned (segment) facts are excluded — the `dim_signature = ''` clause keeps the result
    consolidated (else a segment would double-count)."""
    rows = [
        {"instrument_id": 1, "metric": "total_revenue", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 500.0, "dim_signature": ""},
        {"instrument_id": 1, "metric": "total_revenue", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 200.0, "dim_signature": "segment=us"},
    ]
    reader = _reader_with_fundamentals(rows)
    out = reader.get_fundamentals([1], AS_OF_AFTER_2019)
    rev = [r for r in out[1] if r["metric"] == "total_revenue"]
    assert len(rev) == 1 and rev[0]["value"] == 500.0
    reader.close()


def test_get_fundamentals_multi_instrument_keyed_by_id():
    """Many instruments in one query → results keyed by instrument_id; an instrument with no fact ≤
    as_of is absent from the map (forward-only degrade)."""
    rows = _rows(instrument_id=1) + [
        {"instrument_id": 2, "metric": "net_income", "observation_ts": FY2019, "knowledge_ts": KNOWN_2019, "value": 7.0},
    ]
    reader = _reader_with_fundamentals(rows)
    out = reader.get_fundamentals([1, 2, 999], AS_OF_AFTER_2019)
    assert set(out.keys()) == {1, 2}        # 999 has no facts → absent
    assert any(r["metric"] == "net_income" and r["value"] == 7.0 for r in out[2])
    reader.close()


def test_get_fundamentals_empty_ids_returns_empty():
    reader = _reader_with_fundamentals(_rows())
    assert reader.get_fundamentals([], AS_OF_AFTER_2019) == {}
    reader.close()


def test_get_fundamentals_unbootstrapped_warehouse_degrades_to_empty():
    """A never-backfilled warehouse registers an empty STUB `fundamentals` view (no fact columns), so
    the as-of SELECT can't bind. get_fundamentals must degrade to {} — the live pre-backfill read is
    honest (empty), never an error into the replay."""
    reader = WarehouseReader(warehouse_dir="/nonexistent-warehouse-for-test")   # all stub views
    assert reader.get_fundamentals([1, 2], AS_OF_AFTER_2019) == {}
    reader.close()


def test_fundamentals_views_registered_in_tables():
    """The three fundamentals views are in the reader's TABLES (so they register on construction)."""
    assert {"fundamentals", "fundamentals_revisions_log", "fundamentals_raw_facts"} <= set(WarehouseReader.TABLES)
