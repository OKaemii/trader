"""
DuckDB-over-Parquet warehouse reader. Backtest entry point when
`BacktestRequest.data_source == 'warehouse'`. Reads from the local Parquet
snapshots written by the warehouse-snapshotter CronJob (task 17) at
/srv/warehouse/snapshots/<table>/observation_date=YYYY-MM-DD.parquet.

The warehouse is the canonical historical record — it contains EVERY revision
in the snapshotted window, not just the latest unsuperseded one. The reader's
`as_of_ms` parameter lets a backtest replay see exactly what the strategy saw
at emission time, matching the bi-temporal contract from
agent-docs/plans/point-in-time-bar-history.md.

Single-node DuckDB is intentional: no server, no schema migrations, no
backups. The PV's Parquet directory is the schema; if the disk dies, the
snapshot CronJob recreates everything from Timescale in a few hours and the
backtest engine reopens. Live trading is unaffected.

See agent-docs/plans/three-database-split.md §DuckDB reader.
"""

from __future__ import annotations

import logging
from pathlib import Path

import duckdb

log = logging.getLogger(__name__)

DEFAULT_WAREHOUSE_DIR = '/srv/warehouse/snapshots'


class WarehouseReader:
    """
    Wraps a single in-memory DuckDB connection that has views registered over
    each hypertable's Parquet partitions. Open once per backtest run; queries
    are cheap on the same connection.

    Thread-safety: DuckDB connections are not thread-safe. The backtest engine
    is single-threaded per request (FastAPI worker handles one request at a
    time per worker process), so a single reader instance suffices.
    """

    # Each entry maps to /srv/warehouse/snapshots/<table>/observation_date=*/*.parquet.
    # The Hive partitioning lets DuckDB prune partitions by `observation_date`
    # before reading any file, so a "last 30 days" query touches 30 files of
    # ~1MB each, not the whole warehouse.
    TABLES = (
        'bars',
        'bar_revisions_log',
        'audit_log',
        'data_quality_events',
        'strategy_health_log',
        'risk_rejections',
        'fills_history',
        'reconciliation_log',
    )

    def __init__(self, warehouse_dir: str = DEFAULT_WAREHOUSE_DIR):
        self._dir = Path(warehouse_dir)
        self._con = duckdb.connect(':memory:', read_only=False)
        self._register_views()

    def _register_views(self) -> None:
        for table in self.TABLES:
            pattern = self._dir / table / 'observation_date=*' / '*.parquet'
            try:
                self._con.execute(
                    f"""
                    CREATE VIEW {table} AS
                    SELECT * FROM read_parquet('{pattern}', hive_partitioning = 1)
                    """
                )
            except duckdb.IOException:
                # Partition directory absent (warehouse not yet bootstrapped for
                # this table). Register an empty view so consumers can ask
                # "WHERE … LIMIT 0" without erroring; they'll just get empty
                # results. The CronJob will populate it on the next tick.
                log.warning('warehouse: no snapshots yet for table=%s (will be empty)', table)
                self._con.execute(
                    f"CREATE VIEW {table} AS SELECT NULL WHERE FALSE"
                )

    def get_bars(
        self,
        ticker: str,
        t_lo_ms: int,
        t_hi_ms: int,
        as_of_ms: int | None = None,
    ) -> list[dict]:
        """
        Fetch bars for one ticker in [t_lo_ms, t_hi_ms]. If `as_of_ms` is given,
        returns the latest revision known at that knowledge time per
        observation_ts (bi-temporal as-of read). Without it, returns the latest
        unsuperseded revision (live read).
        """
        if as_of_ms is None:
            sql = """
                SELECT * FROM bars
                WHERE ticker = ?
                  AND observation_ts BETWEEN ? AND ?
                  AND is_superseded = FALSE
                ORDER BY observation_ts
            """
            params: list = [ticker, t_lo_ms, t_hi_ms]
        else:
            # Window-function pick: latest knowledge_ts <= as_of per observation_ts.
            sql = """
                SELECT * FROM (
                  SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY observation_ts ORDER BY knowledge_ts DESC
                  ) AS rn
                  FROM bars
                  WHERE ticker = ?
                    AND observation_ts BETWEEN ? AND ?
                    AND knowledge_ts <= ?
                ) sub
                WHERE rn = 1
                ORDER BY observation_ts
            """
            params = [ticker, t_lo_ms, t_hi_ms, as_of_ms]

        rel = self._con.execute(sql, params)
        cols = [d[0] for d in rel.description]
        return [dict(zip(cols, row)) for row in rel.fetchall()]

    def get_bars_batch(
        self,
        tickers: list[str],
        t_lo_ms: int,
        t_hi_ms: int,
        as_of_ms: int | None = None,
    ) -> dict[str, list[dict]]:
        """
        Same as get_bars but for many tickers in one DuckDB query. Returns
        {ticker: [bars...]}. Tickers with no rows are absent from the result.
        """
        if not tickers:
            return {}
        # DuckDB doesn't have an `ANY($1::text[])` param shape like PG; build
        # a list-shaped placeholder.
        placeholders = ','.join('?' for _ in tickers)
        if as_of_ms is None:
            sql = f"""
                SELECT * FROM bars
                WHERE ticker IN ({placeholders})
                  AND observation_ts BETWEEN ? AND ?
                  AND is_superseded = FALSE
                ORDER BY ticker, observation_ts
            """
            params = [*tickers, t_lo_ms, t_hi_ms]
        else:
            sql = f"""
                SELECT * FROM (
                  SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY ticker, observation_ts ORDER BY knowledge_ts DESC
                  ) AS rn
                  FROM bars
                  WHERE ticker IN ({placeholders})
                    AND observation_ts BETWEEN ? AND ?
                    AND knowledge_ts <= ?
                ) sub
                WHERE rn = 1
                ORDER BY ticker, observation_ts
            """
            params = [*tickers, t_lo_ms, t_hi_ms, as_of_ms]

        rel = self._con.execute(sql, params)
        cols = [d[0] for d in rel.description]
        out: dict[str, list[dict]] = {}
        for row in rel.fetchall():
            r = dict(zip(cols, row))
            out.setdefault(r['ticker'], []).append(r)
        return out

    def close(self) -> None:
        self._con.close()

    def __enter__(self) -> 'WarehouseReader':
        return self

    def __exit__(self, *exc) -> None:
        self.close()
