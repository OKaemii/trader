"""Ingest point-in-time S&P 500 membership → the `index_constituents` collection (Phase 6).

Source: the fja05680/sp500 community CSV — a series of *snapshots* (one row per change date,
each listing every ticker in the index on that date). We diff consecutive snapshots into
`{index, ticker, effective_from, effective_to}` intervals so the validator can ask "who was in
the index on 2017-06-01?" and stop projecting today's survivors backward.

Provenance is ~95% accurate (community-maintained); the paid upgrade is Norgate/EODHD. Every run
stamps `data_source='fja05680_sp500_csv'` and writes the raw CSV to `index_constituents_audit`
for forensic. Idempotent: upsert by (index, ticker, effective_from) — re-running changes nothing.

Usage:
    MONGODB_URL=… python -m src.scripts.ingest_sp500_history [--url <csv>] [--index sp500]

The pure functions (`parse_snapshots`, `build_intervals`) carry the logic and are unit-tested;
the network + Mongo wrappers are thin. If fja05680 renames the file or changes the column shape,
the parse raises and the operator points `--url` at the new location (a known fragility).
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import io
import os
from datetime import datetime, timezone
from typing import Optional

DEFAULT_CSV_URL = (
    "https://raw.githubusercontent.com/fja05680/sp500/master/"
    "S%26P%20500%20Historical%20Components%20%26%20Changes(MM-DD-YYYY).csv"
)
DAY_MS = 86_400_000


def _to_ms(date_str: str) -> int:
    """Parse a snapshot date (tolerant of the formats fja05680 has used) → UTC midnight ms."""
    s = date_str.strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y", "%Y/%m/%d"):
        try:
            d = datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
            return int(d.timestamp() * 1000)
        except ValueError:
            continue
    raise ValueError(f"unrecognised snapshot date format: {date_str!r}")


def parse_snapshots(csv_text: str) -> list[tuple[int, set[str]]]:
    """CSV text → [(snapshot_ms, {tickers})], ascending by date. Expects a `date,tickers` shape
    where `tickers` is a comma-separated list (one quoted CSV field)."""
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    if not rows:
        return []
    # Skip a header row if present (first cell isn't a parseable date).
    start = 0
    try:
        _to_ms(rows[0][0])
    except (ValueError, IndexError):
        start = 1
    snapshots: list[tuple[int, set[str]]] = []
    for row in rows[start:]:
        if len(row) < 2 or not row[0].strip():
            continue
        ms = _to_ms(row[0])
        tickers = {t.strip().upper() for t in row[1].split(",") if t.strip()}
        if tickers:
            snapshots.append((ms, tickers))
    snapshots.sort(key=lambda x: x[0])
    return snapshots


def build_intervals(snapshots: list[tuple[int, set[str]]], index: str = "sp500") -> list[dict]:
    """Diff consecutive snapshots into membership intervals.

    A ticker present in snapshot k but not k-1 opens an interval at snapshot[k].date; a ticker in
    k-1 but not k closes the open interval at snapshot[k].date (the first date it was absent).
    Tickers in the final snapshot stay open (effective_to=None). A ticker that left and rejoined
    yields two rows — which is the whole point of point-in-time membership.
    """
    intervals: list[dict] = []
    open_from: dict[str, int] = {}  # ticker -> effective_from of its currently-open interval
    prev: set[str] = set()
    for ms, tickers in snapshots:
        for t in tickers - prev:                      # joined at this snapshot
            open_from.setdefault(t, ms)
        for t in prev - tickers:                      # left at this snapshot
            if t in open_from:
                intervals.append({"index": index, "ticker": t,
                                  "effective_from": open_from.pop(t), "effective_to": ms})
        prev = tickers
    for t, frm in open_from.items():                  # still members at the last snapshot
        intervals.append({"index": index, "ticker": t, "effective_from": frm, "effective_to": None})
    intervals.sort(key=lambda r: (r["ticker"], r["effective_from"]))
    return intervals


async def _fetch_csv(url: str, timeout: float = 60.0) -> str:
    import httpx

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        r = await client.get(url, headers={"User-Agent": "trader-ingester/1.0"})
        r.raise_for_status()
        return r.text


async def ingest(db, url: str = DEFAULT_CSV_URL, index: str = "sp500") -> dict:
    csv_text = await _fetch_csv(url)
    snapshots = parse_snapshots(csv_text)
    if len(snapshots) < 2:
        raise SystemExit(f"refusing to ingest: only {len(snapshots)} snapshots parsed from {url}")
    intervals = build_intervals(snapshots, index)

    now = datetime.now(timezone.utc)
    for row in intervals:
        await db["index_constituents"].update_one(
            {"index": row["index"], "ticker": row["ticker"], "effective_from": row["effective_from"]},
            {"$set": {**row, "data_source": "fja05680_sp500_csv", "ingested_at": now}},
            upsert=True,
        )
    await db["index_constituents_audit"].insert_one(
        {"index": index, "source_url": url, "rows": len(intervals),
         "snapshots": len(snapshots), "raw_csv": csv_text, "ingested_at": now}
    )
    span = (snapshots[0][0], snapshots[-1][0])
    return {"intervals": len(intervals), "snapshots": len(snapshots),
            "from_ms": span[0], "to_ms": span[1]}


async def _main(url: str, index: str) -> None:
    import motor.motor_asyncio

    mongo_url = os.getenv("MONGODB_URL", "mongodb://localhost:27017")
    db = motor.motor_asyncio.AsyncIOMotorClient(mongo_url)[os.getenv("MONGODB_DB", "trader")]
    result = await ingest(db, url=url, index=index)
    print(f"ingested {result['intervals']} intervals from {result['snapshots']} snapshots "
          f"({datetime.fromtimestamp(result['from_ms']/1000, timezone.utc).date()} → "
          f"{datetime.fromtimestamp(result['to_ms']/1000, timezone.utc).date()})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Ingest point-in-time S&P 500 membership.")
    ap.add_argument("--url", default=DEFAULT_CSV_URL)
    ap.add_argument("--index", default="sp500")
    args = ap.parse_args()
    asyncio.run(_main(args.url, args.index))
