"""Identity layer — the symbol↔CIK history the lake reader resolves against.

The stable identifier is the SEC CIK, never the ticker. Tickers are time-varying attributes stored
with validity ranges, built by diffing daily snapshots of `company_tickers.json` (plus an optional
seed CSV for history before this system existed, e.g. FB → META on 2022-06-09). Because Facebook/Meta
kept CIK 1326801 through the rename, all of its fundamentals history is continuous for free.

This writes two of the three lake files the read engine (`quant_core.fundamentals.lake.store`) reads:

  * `ticker_history.parquet` — bare `ticker` → `cik` with `[valid_from, valid_to)` ranges. The store's
    `resolve(symbol, as_of)` reads this (rename-aware). Symbols are the BARE exchange symbol (`META`,
    `GOOGL`) — EDGAR's `company_tickers.json` is already bare, and the read engine keys on the bare
    symbol of a `TickerIdentity` (the `_US_EQ` form never reaches the lake).
  * `entities.parquet` — per-CIK name / SIC / exchanges / current tickers / former-name history,
    merged from `/submissions` docs (the SIC feeds the lake's sector-template metric selection).

Writes are atomic (tmpfile + `os.replace`) so a reader never observes a half-written file.
"""
from __future__ import annotations

import csv
import json
import os
from datetime import date
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

TICKER_SCHEMA = pa.schema(
    [
        ("cik", pa.int32()),
        ("ticker", pa.string()),
        ("valid_from", pa.date32()),
        ("valid_to", pa.date32()),  # null = currently listed under this symbol
    ]
)

ENTITY_SCHEMA = pa.schema(
    [
        ("cik", pa.int32()),
        ("name", pa.string()),
        ("sic", pa.string()),
        ("sic_desc", pa.string()),
        ("exchanges", pa.string()),     # JSON list
        ("tickers", pa.string()),       # JSON list (current)
        ("former_names", pa.string()),  # JSON list of {name, from, to}
    ]
)


def _read(path: Path) -> list[dict]:
    return pq.read_table(path).to_pylist() if path.exists() else []


def _write(path: Path, rows: list[dict], schema: pa.Schema) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), tmp, compression="zstd")
    os.replace(tmp, path)


def snapshot_tickers(lake: Path, current_map: dict, today: date | None = None) -> None:
    """Diff today's universe against history; renames/delistings accrue automatically.

    A listing that vanished from `company_tickers.json` (a rename or a delisting) has its open range
    closed at `today`; a newly-seen `(ticker, cik)` opens a new open-ended range.
    """
    today = today or date.today()
    path = lake / "ticker_history.parquet"
    rows = _read(path)
    live = {(v["ticker"].upper(), int(v["cik_str"])) for v in current_map.values()}
    open_now = {(r["ticker"], r["cik"]) for r in rows if r["valid_to"] is None}

    for r in rows:  # close listings that vanished (rename or delisting)
        if r["valid_to"] is None and (r["ticker"], r["cik"]) not in live:
            r["valid_to"] = today
    for tkr, cik in sorted(live - open_now):  # open newly seen listings
        rows.append({"cik": cik, "ticker": tkr, "valid_from": today, "valid_to": None})

    _write(path, rows, TICKER_SCHEMA)


def seed_ticker_history(lake: Path, csv_path: Path) -> int:
    """Retro-fill known historical symbols (cik,ticker,valid_from[,valid_to]) from a seed CSV.

    De-duplicated on `(ticker, cik, valid_from)` so re-seeding is idempotent. Returns the number of
    NEW rows appended. Carries the FB→META rename history that predates this system.
    """
    path = lake / "ticker_history.parquet"
    rows = _read(path)
    have = {(r["ticker"], r["cik"], r["valid_from"]) for r in rows}
    added = 0
    with open(csv_path, newline="") as f:
        for line in csv.DictReader(f):
            row = {
                "cik": int(line["cik"]),
                "ticker": line["ticker"].upper(),
                "valid_from": date.fromisoformat(line["valid_from"]),
                "valid_to": date.fromisoformat(line["valid_to"]) if line.get("valid_to") else None,
            }
            if (row["ticker"], row["cik"], row["valid_from"]) not in have:
                rows.append(row)
                added += 1
    _write(path, rows, TICKER_SCHEMA)
    return added


def upsert_entities(lake: Path, submissions_docs: list[dict]) -> None:
    """Merge entity metadata from `/submissions` docs into `entities.parquet` (last write wins per CIK)."""
    path = lake / "entities.parquet"
    rows = {r["cik"]: r for r in _read(path)}
    for subs in submissions_docs:
        cik = int(subs["cik"])
        rows[cik] = {
            "cik": cik,
            "name": subs.get("name"),
            "sic": subs.get("sic"),
            "sic_desc": subs.get("sicDescription"),
            "exchanges": json.dumps(subs.get("exchanges") or []),
            "tickers": json.dumps(subs.get("tickers") or []),
            "former_names": json.dumps(subs.get("formerNames") or []),
        }
    _write(path, list(rows.values()), ENTITY_SCHEMA)
