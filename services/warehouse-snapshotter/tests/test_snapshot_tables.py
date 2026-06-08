"""Snapshotter TABLES specs — the warehouse must snapshot the three PIT-fundamentals hypertables
with the correct time columns so a warehouse-source backtest can read true point-in-time fundamentals
(PIT-fundamentals epic Task 15).

Deps-clean: conftest stubs psycopg/pyarrow, so importing `src.snapshot` here exercises only the pure
`TABLES`/`TableSpec` metadata — no Timescale, no Parquet. The time columns are reconciled against
0009_fundamentals.sql: `fundamentals` + `fundamentals_revisions_log` key on `observation_ts` (= fiscal
period_end), `fundamentals_raw_facts` on `period_end`; all three are BIGINT-ms.
"""
from src.snapshot import TABLES, TableSpec


def _spec(name: str) -> TableSpec:
    matches = [t for t in TABLES if t.name == name]
    assert len(matches) == 1, f"expected exactly one TableSpec named {name!r}, got {len(matches)}"
    return matches[0]


def test_fundamentals_tables_present_with_correct_time_columns():
    """The three 0009_fundamentals.sql hypertables are snapshotted with their actual BIGINT-ms time
    columns — `fundamentals`/`fundamentals_revisions_log` on observation_ts, raw facts on period_end."""
    fundamentals = _spec("fundamentals")
    assert fundamentals.time_column == "observation_ts"
    assert fundamentals.time_is_bigint is True

    revisions = _spec("fundamentals_revisions_log")
    assert revisions.time_column == "observation_ts"
    assert revisions.time_is_bigint is True

    raw = _spec("fundamentals_raw_facts")
    assert raw.time_column == "period_end"   # the raw zone's hypertable time dimension (0009)
    assert raw.time_is_bigint is True


def test_all_three_fundamentals_tables_registered():
    """All three (not a subset) are in TABLES — a partial registration would silently truncate the
    warehouse's fundamentals coverage."""
    names = {t.name for t in TABLES}
    assert {"fundamentals", "fundamentals_revisions_log", "fundamentals_raw_facts"} <= names


def test_existing_bar_specs_unchanged():
    """Regression guard: the bars specs Task 15 sits beside are untouched (bigint observation_ts)."""
    bars = _spec("bars")
    assert bars.time_column == "observation_ts" and bars.time_is_bigint is True
    bar_rev = _spec("bar_revisions_log")
    assert bar_rev.time_column == "observation_ts" and bar_rev.time_is_bigint is True
