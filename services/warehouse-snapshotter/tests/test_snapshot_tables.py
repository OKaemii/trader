"""Snapshotter TABLES specs — after the PIT-fundamentals lake re-architecture (epic Task 12), the
warehouse must NOT snapshot the fundamentals hypertables: the PIT lake (per-CIK Parquet, owned by the
fundamentals-harvester) is the single PIT fundamentals store, and backtest replay reads it directly
via quant_core.fundamentals.lake.replay.LakePitFundamentals. The `bars` snapshot is UNCHANGED — the
backtest still reads daily bars from the warehouse (the price panel + the market-cap price leg).

Deps-clean: conftest stubs psycopg/pyarrow, so importing `src.snapshot` here exercises only the pure
`TABLES`/`TableSpec` metadata — no Timescale, no Parquet.
"""
from src.snapshot import TABLES, TableSpec


def _names() -> set[str]:
    return {t.name for t in TABLES}


def _spec(name: str) -> TableSpec:
    matches = [t for t in TABLES if t.name == name]
    assert len(matches) == 1, f"expected exactly one TableSpec named {name!r}, got {len(matches)}"
    return matches[0]


def test_fundamentals_tables_are_not_snapshotted():
    """The three 0009_fundamentals.sql hypertables are GONE from TABLES — the PIT lake is the single
    fundamentals store backtest replay reads directly; nothing reads a fundamentals snapshot now."""
    names = _names()
    assert "fundamentals" not in names
    assert "fundamentals_revisions_log" not in names
    assert "fundamentals_raw_facts" not in names
    # Defensive: no fundamentals-prefixed table sneaks back in.
    assert not any(n.startswith("fundamentals") for n in names)


def test_bars_snapshot_is_unchanged():
    """Regression guard: the `bars` snapshot the backtest's price panel + market-cap price leg depend
    on is untouched (bigint observation_ts) — only the fundamentals branch was dropped."""
    bars = _spec("bars")
    assert bars.time_column == "observation_ts" and bars.time_is_bigint is True
    bar_rev = _spec("bar_revisions_log")
    assert bar_rev.time_column == "observation_ts" and bar_rev.time_is_bigint is True


def test_audit_ledgers_still_snapshotted():
    """The append-only audit/ops ledgers remain in TABLES (the fundamentals drop is surgical — it does
    not touch any other table)."""
    names = _names()
    for table in (
        "audit_log",
        "data_quality_events",
        "strategy_health_log",
        "risk_rejections",
        "fills_history",
        "reconciliation_log",
    ):
        assert table in names
