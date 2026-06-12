#!/usr/bin/env python3
"""
Warehouse snapshotter — exports yesterday's window from every Timescale
hypertable to Parquet under /srv/warehouse/snapshots/{table}/observation_date={YYYY-MM-DD}.parquet.

Runs daily as a Kubernetes CronJob (infra/helm/trader/templates/warehouse-snapshot-cronjob.yaml).
Idempotent on (table, snapshot_date): re-running for the same day rewrites
atomically via tempfile + rename, so a partially-written file is impossible
for downstream readers (DuckDB) to observe.

Layout:
  /srv/warehouse/snapshots/
    bars/
      observation_date=2026-05-22.parquet
      observation_date=2026-05-23.parquet
    bar_revisions_log/
      observation_date=2026-05-22.parquet
      ...
    audit_log/
      observation_date=2026-05-22.parquet
      ...

DuckDB consumes the Hive-style `observation_date=…` partitioning via
read_parquet('.../observation_date=*/*.parquet', hive_partitioning=1) — the
backtest-engine WarehouseReader (task 18) does exactly this.

Behaviour by table:
  - bars / bar_revisions_log         — observation_ts column (BIGINT ms); partition on the UTC day of that timestamp.
  - audit_log / data_quality_events  — occurred_at column (TIMESTAMPTZ); partition by date_trunc('day').
  - strategy_health_log              — occurred_at TIMESTAMPTZ.
  - risk_rejections                  — occurred_at TIMESTAMPTZ.
  - fills_history                    — filled_at TIMESTAMPTZ.
  - reconciliation_log               — occurred_at TIMESTAMPTZ.

PIT fundamentals are NOT snapshotted here (epic pit-fundamentals-lake-rearchitecture, Task 12).
The PIT fundamentals lake (per-CIK Parquet, owned by the fundamentals-harvester) is now the single
PIT fundamentals store, and backtest replay reads it directly via
quant_core.fundamentals.lake.replay.LakePitFundamentals — so the old `fundamentals*` Timescale
snapshot branch was dropped. The `bars` snapshot is UNCHANGED: backtest still reads daily bars from
the warehouse (the market-cap price leg + the price panel), and the lake supplies the as-of line
items. Nothing else reads a fundamentals snapshot after this change.

Each snapshot includes EVERY revision in the day's window — not just the
latest unsuperseded one. Research queries get to pick which revision to use;
the warehouse is the canonical historical record.

See agent-docs/plans/three-database-split.md §Warehouse snapshotter.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pyarrow as pa
import pyarrow.parquet as pq

log = logging.getLogger("warehouse-snapshotter")


# Hypertables we snapshot. `time_column` is the partitioning column; `time_is_bigint`
# tells the query layer whether to compare against epoch-ms (BIGINT) or
# date_trunc on TIMESTAMPTZ.
@dataclass(frozen=True)
class TableSpec:
    name:           str
    time_column:    str
    time_is_bigint: bool


TABLES: list[TableSpec] = [
    TableSpec(name='bars',                  time_column='observation_ts', time_is_bigint=True),
    TableSpec(name='bar_revisions_log',     time_column='observation_ts', time_is_bigint=True),
    TableSpec(name='audit_log',             time_column='occurred_at',    time_is_bigint=False),
    TableSpec(name='data_quality_events',   time_column='occurred_at',    time_is_bigint=False),
    TableSpec(name='strategy_health_log',   time_column='occurred_at',    time_is_bigint=False),
    TableSpec(name='risk_rejections',       time_column='occurred_at',    time_is_bigint=False),
    TableSpec(name='fills_history',         time_column='filled_at',      time_is_bigint=False),
    TableSpec(name='reconciliation_log',    time_column='occurred_at',    time_is_bigint=False),
    # NOTE: the PIT-fundamentals hypertables (`fundamentals`, `fundamentals_revisions_log`,
    # `fundamentals_raw_facts`, 0009_fundamentals.sql) are deliberately NOT snapshotted — the PIT
    # fundamentals lake is the single source backtest replay reads directly (epic Task 12). The
    # `bars` snapshot above is unchanged.
]


def snapshot_table(conn: psycopg.Connection, spec: TableSpec, snapshot_date: date, out_dir: Path) -> int:
    """
    Dump one table's day-window to Parquet. Returns the row count written.
    Atomic via tmpfile + rename: a concurrent reader never sees a partial file.
    """
    out_file = out_dir / spec.name / f"observation_date={snapshot_date.isoformat()}.parquet"
    tmp_file = out_file.with_suffix('.parquet.tmp')
    out_file.parent.mkdir(parents=True, exist_ok=True)

    # Day window: [start, end) in either epoch-ms (BIGINT tables) or TIMESTAMPTZ.
    day_start_dt = datetime.combine(snapshot_date, datetime.min.time(), tzinfo=timezone.utc)
    day_end_dt   = day_start_dt + timedelta(days=1)

    if spec.time_is_bigint:
        day_start = int(day_start_dt.timestamp() * 1000)
        day_end   = int(day_end_dt.timestamp() * 1000)
    else:
        day_start = day_start_dt
        day_end   = day_end_dt

    # Stream-fetch with named cursor. Avoids loading the whole result into RAM
    # — fills_history or bars at universe scale × full day can be hundreds of
    # thousands of rows.
    select_sql = f"""
        SELECT * FROM {spec.name}
        WHERE {spec.time_column} >= %s AND {spec.time_column} < %s
        ORDER BY {spec.time_column}
    """
    rows: list[dict] = []
    cols: list[str] = []
    with conn.cursor(name=f'snapshot_{spec.name}') as cur:
        cur.itersize = 10_000
        cur.execute(select_sql, (day_start, day_end))
        # cur.description is populated after execute(); use it whether or not
        # there are rows so the empty-rows path still writes a typed schema.
        if cur.description:
            cols = [c.name for c in cur.description]
        for row in cur:
            rows.append({col: row[i] for i, col in enumerate(cols)})

    if not rows:
        # Empty file is still useful — tells DuckDB "this partition exists with
        # zero rows" rather than "this partition is missing." Schema fields
        # default to string type since we have no rows from which to infer the
        # real column types; downstream readers cast as needed.
        if not cols:
            cols = ['_empty']
        schema = pa.schema([(c, pa.string()) for c in cols])
        empty = pa.Table.from_pylist([], schema=schema)
        pq.write_table(empty, tmp_file, compression='zstd', compression_level=3)
        tmp_file.rename(out_file)
        return 0

    table = pa.Table.from_pylist(rows)
    pq.write_table(table, tmp_file, compression='zstd', compression_level=3)
    tmp_file.rename(out_file)
    return len(rows)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

    p = argparse.ArgumentParser(description='Snapshot Timescale hypertables to Parquet.')
    p.add_argument('--date',  help='UTC date to snapshot (YYYY-MM-DD). Defaults to yesterday UTC.')
    p.add_argument('--out',   default='/srv/warehouse/snapshots',
                   help='Output directory root. Default: /srv/warehouse/snapshots.')
    p.add_argument('--tables', help='Comma-separated subset of table names to snapshot. Default: all.')
    args = p.parse_args()

    if args.date:
        snapshot_date = date.fromisoformat(args.date)
    else:
        snapshot_date = (datetime.now(timezone.utc) - timedelta(days=1)).date()

    tables = TABLES
    if args.tables:
        wanted = set(args.tables.split(','))
        tables = [t for t in TABLES if t.name in wanted]
        unknown = wanted - {t.name for t in TABLES}
        if unknown:
            log.warning('unknown table names ignored: %s', sorted(unknown))

    timescale_url = os.environ.get('TIMESCALE_URL')
    if not timescale_url:
        log.error('TIMESCALE_URL not set')
        return 1

    out_dir = Path(args.out)
    log.info('snapshot start: date=%s out=%s tables=%s', snapshot_date, out_dir, [t.name for t in tables])

    total_rows = 0
    with psycopg.connect(timescale_url) as conn:
        for spec in tables:
            try:
                n = snapshot_table(conn, spec, snapshot_date, out_dir)
                total_rows += n
                log.info('  %-22s rows=%d', spec.name, n)
            except Exception as err:
                # Per-table isolation: a single broken table doesn't abort the
                # whole snapshot. The cron rerun next day picks up where we
                # left off; an operator inspects the log for the failed table.
                log.exception('  %-22s FAILED: %s', spec.name, err)

    log.info('snapshot complete: total_rows=%d', total_rows)
    return 0


if __name__ == '__main__':
    sys.exit(main())
