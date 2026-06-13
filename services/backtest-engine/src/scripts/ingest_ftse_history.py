"""Ingest point-in-time FTSE 100 membership → the `index_constituents` collection (Phase 6, UK twin).

The UK equivalent of `ingest_sp500_history.py`: it diffs a series of *snapshots* (one full
membership list per date) into `{index, ticker, effective_from, effective_to}` intervals in the
SAME `index_constituents` collection, so a survivorship-free walk can ask "who was in the FTSE 100
on 2024-01-01?" instead of projecting today's survivors backward. Rows are tagged `index='FTSE100'`
so they never collide with the `sp500` rows in the shared collection, and the same index-agnostic
`quant_core.universe` loader (`load_constituents`/`active_union`) resolves them once the caller
filters `{'index': 'FTSE100'}` on the Mongo read.

Source — the `yfiua/index-constituents` community dataset (Apache-2.0, free, commercial use OK):
each month is published as a full-membership CSV at
`https://yfiua.github.io/index-constituents/$YYYY/$MM/constituents-ftse100.csv` with a `Symbol,Name`
header and Yahoo-style LSE symbols (`AAL.L`, `BA/.L`). We page the monthly snapshots over a date
range and diff them — identical machinery to the S&P path, fed snapshot-per-file instead of
snapshot-per-row.

  ⚠ DEPTH CAVEAT (be honest, like the S&P delisted-prices gap): this free source's FTSE 100 history
  begins **July 2023** (`DEFAULT_HISTORY_START`). That is enough for a survivorship-free walk *within*
  that window, but it is NOT deep back-history. Deeper FTSE membership (pre-2023, and FTSE 250/350)
  needs a paid/community source (Norgate, LSEG/FTSE Russell, or a hand-curated Wikipedia
  constituent-change scrape). The interval math below is source-agnostic — point `--base-url` /
  `--index` at a deeper feed when one is licensed and the same diff applies. Every run stamps
  `data_source='yfiua_index_constituents_csv'` and writes the raw snapshots to
  `index_constituents_audit` for forensic.

Ticker convention — stored in the platform's **T212 LSE form** (`*l_EQ`), mirroring how the live
universe stores LSE names (`values.yaml universeIncludeLSE` → `UniverseManager` → `VODl_EQ`), NOT the
Yahoo `*.L` form the S&P bare-symbol rows happen to round-trip through. So a downstream consumer that
reads these rows gets the same shape it sees everywhere else, and `quant_core` `to_yahoo_symbol`
maps it back to `.L` for the Yahoo daily reader. The transform: `AAL.L → AALl_EQ`; the Yahoo
space/class marker `/` (e.g. `BA/.L` BAE, `HL/.L`, `TW/.L`) is dropped to match T212 (`BAl_EQ`).

Idempotent: upsert by `(index, ticker, effective_from)` — re-running changes nothing.

Usage:
    MONGODB_URL=… python -m src.scripts.ingest_ftse_history \
        [--index FTSE100] [--start 2023-07] [--end 2026-06] [--base-url <…>]

The pure functions (`yahoo_lse_to_t212`, `parse_constituents_csv`, `build_intervals`,
`months_in_range`) carry the logic and are unit-tested; the network + Mongo wrappers are thin. If
yfiua changes the URL shape or column header the parse raises and the operator repoints `--base-url`
(a known fragility, identical to the S&P `--url` escape hatch).
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import io
import os
from datetime import datetime, timezone
from typing import Optional

# yfiua publishes FTSE 100 from 2023/07 onward (earlier months 404). The UK depth caveat above.
DEFAULT_HISTORY_START = "2023-07"
DEFAULT_BASE_URL = "https://yfiua.github.io/index-constituents"
DEFAULT_INDEX = "FTSE100"
# yfiua's per-index file code is lowercase (constituents-ftse100.csv); derive it from the index tag.
_INDEX_CODE = {"FTSE100": "ftse100", "FTSE250": "ftse250", "FTSE350": "ftse350"}


def _month_to_ms(year: int, month: int) -> int:
    """First-of-month UTC midnight → ms (the snapshot's effective instant)."""
    d = datetime(year, month, 1, tzinfo=timezone.utc)
    return int(d.timestamp() * 1000)


def _parse_ym(s: str) -> tuple[int, int]:
    """`'2023-07'` → `(2023, 7)`; tolerant of `'2023/07'`."""
    txt = s.strip().replace("/", "-")
    parts = txt.split("-")
    if len(parts) != 2:
        raise ValueError(f"expected YYYY-MM, got {s!r}")
    return int(parts[0]), int(parts[1])


def months_in_range(start_ym: str, end_ym: str) -> list[tuple[int, int]]:
    """Inclusive list of `(year, month)` from `start_ym` to `end_ym` — one per monthly snapshot."""
    sy, sm = _parse_ym(start_ym)
    ey, em = _parse_ym(end_ym)
    if (ey, em) < (sy, sm):
        raise ValueError(f"end {end_ym} precedes start {start_ym}")
    out: list[tuple[int, int]] = []
    y, m = sy, sm
    while (y, m) <= (ey, em):
        out.append((y, m))
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def yahoo_lse_to_t212(symbol: str) -> Optional[str]:
    """Yahoo-style LSE symbol → the platform's T212 LSE ticker (`*l_EQ`), or None if not a `.L` name.

    `AAL.L → AALl_EQ`. The Yahoo space/class marker `/` is dropped so it matches the T212 primary
    listing (`BA/.L` BAE → `BAl_EQ`; `HL/.L → HLl_EQ`; `TW/.L → TWl_EQ`) — exactly the bare symbols
    `values.yaml universeIncludeLSE` carries, which `UniverseManager` suffixes with `l_EQ`. A symbol
    that doesn't end in `.L` (defensive — yfiua's FTSE files are all `.L`) returns None and is skipped.
    """
    s = symbol.strip().upper()
    if not s.endswith(".L"):
        return None
    base = s[:-2].replace("/", "")  # strip the '.L' suffix, then drop the Yahoo class slash
    if not base:
        return None
    return f"{base}l_EQ"


def parse_constituents_csv(csv_text: str) -> set[str]:
    """A single monthly snapshot CSV (`Symbol,Name` header, Yahoo `.L` symbols) → {T212 tickers}.

    Skips the header (case-insensitive `symbol`) and maps each symbol through `yahoo_lse_to_t212`;
    unmappable rows are dropped. Returns the membership set for that month."""
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    out: set[str] = set()
    for i, row in enumerate(rows):
        if not row or not row[0].strip():
            continue
        sym = row[0].strip()
        if i == 0 and sym.lower() == "symbol":  # header
            continue
        t212 = yahoo_lse_to_t212(sym)
        if t212:
            out.add(t212)
    return out


def build_intervals(snapshots: list[tuple[int, set[str]]], index: str = DEFAULT_INDEX) -> list[dict]:
    """Diff consecutive snapshots into membership intervals (identical semantics to the S&P path).

    A ticker present in snapshot k but not k-1 opens an interval at snapshot[k].date; a ticker in
    k-1 but not k closes the open interval at snapshot[k].date (the first date it was absent).
    Tickers in the final snapshot stay open (`effective_to=None`). A ticker that left and rejoined
    yields two rows — the whole point of point-in-time membership.
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


def _csv_url(base_url: str, index: str, year: int, month: int) -> str:
    code = _INDEX_CODE.get(index.upper())
    if code is None:
        raise ValueError(f"no yfiua file code for index {index!r}; pass --base-url for a custom feed")
    return f"{base_url.rstrip('/')}/{year:04d}/{month:02d}/constituents-{code}.csv"


async def _fetch_csv(url: str, timeout: float = 60.0) -> Optional[str]:
    """Fetch one monthly snapshot. A 404 (month not yet published) → None (skipped), not an error."""
    import httpx

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        r = await client.get(url, headers={"User-Agent": "trader-ingester/1.0"})
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.text


async def fetch_snapshots(
    base_url: str, index: str, months: list[tuple[int, int]]
) -> list[tuple[int, set[str]]]:
    """Page the monthly CSVs, parse each into a membership set, return ascending `[(ms, {tickers})]`.

    Missing months (404) are skipped so a partially-published range still yields a usable series."""
    snaps: list[tuple[int, set[str]]] = []
    for year, month in months:
        text = await _fetch_csv(_csv_url(base_url, index, year, month))
        if text is None:
            continue
        tickers = parse_constituents_csv(text)
        if tickers:
            snaps.append((_month_to_ms(year, month), tickers))
    snaps.sort(key=lambda x: x[0])
    return snaps


async def ingest(
    db,
    base_url: str = DEFAULT_BASE_URL,
    index: str = DEFAULT_INDEX,
    start_ym: str = DEFAULT_HISTORY_START,
    end_ym: Optional[str] = None,
) -> dict:
    if end_ym is None:
        now = datetime.now(timezone.utc)
        end_ym = f"{now.year:04d}-{now.month:02d}"
    months = months_in_range(start_ym, end_ym)
    snapshots = await fetch_snapshots(base_url, index, months)
    if len(snapshots) < 1:
        raise SystemExit(
            f"refusing to ingest: 0 snapshots fetched for {index} {start_ym}..{end_ym} "
            f"from {base_url} (source moved? check the URL shape)"
        )
    intervals = build_intervals(snapshots, index)

    # index_constituents is keyed on the bare (symbol, market) identity since Task 16b — the
    # concatenated T212 ticker is no longer stored. The build_intervals tickers are the T212 LSE form
    # (`AALl_EQ`), so split each through the canonical adapter (the one suffix parser) → {symbol, market}
    # = {'AAL', 'LSE'}; the upsert key + the row drop `ticker` for `symbol`+`market`. A token that
    # can't be parsed to a US/LSE form is skipped (fail-soft). Consumers keep filtering by `index`.
    from quant_core.ticker_identity import Trading212TickerAdapter

    adapter = Trading212TickerAdapter()
    now = datetime.now(timezone.utc)
    written = 0
    for row in intervals:
        try:
            ident = adapter.from_t212(row["ticker"])
        except Exception:  # noqa: BLE001 — an un-routable token is dropped, never aborts the ingest
            continue
        doc = {"index": row["index"], "symbol": ident.symbol, "market": ident.market,
               "effective_from": row["effective_from"], "effective_to": row["effective_to"]}
        await db["index_constituents"].update_one(
            {"index": doc["index"], "symbol": doc["symbol"], "market": doc["market"],
             "effective_from": doc["effective_from"]},
            {"$set": {**doc, "data_source": "yfiua_index_constituents_csv", "ingested_at": now}},
            upsert=True,
        )
        written += 1
    await db["index_constituents_audit"].insert_one(
        {"index": index, "source_url": f"{base_url} ({start_ym}..{end_ym})", "rows": written,
         "snapshots": len(snapshots), "ingested_at": now}
    )
    span = (snapshots[0][0], snapshots[-1][0])
    return {"intervals": written, "snapshots": len(snapshots),
            "from_ms": span[0], "to_ms": span[1]}


async def _main(base_url: str, index: str, start_ym: str, end_ym: Optional[str]) -> None:
    import motor.motor_asyncio

    mongo_url = os.getenv("MONGODB_URL", "mongodb://localhost:27017")
    db = motor.motor_asyncio.AsyncIOMotorClient(mongo_url)[os.getenv("MONGODB_DB", "trader")]
    result = await ingest(db, base_url=base_url, index=index, start_ym=start_ym, end_ym=end_ym)
    print(f"ingested {result['intervals']} {index} intervals from {result['snapshots']} snapshots "
          f"({datetime.fromtimestamp(result['from_ms']/1000, timezone.utc).date()} → "
          f"{datetime.fromtimestamp(result['to_ms']/1000, timezone.utc).date()})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Ingest point-in-time FTSE membership (UK twin of S&P).")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL,
                    help="yfiua index-constituents base (override for a deeper/licensed feed)")
    ap.add_argument("--index", default=DEFAULT_INDEX, help="index tag stored on every row (e.g. FTSE100)")
    ap.add_argument("--start", default=DEFAULT_HISTORY_START, help="first snapshot month YYYY-MM")
    ap.add_argument("--end", default=None, help="last snapshot month YYYY-MM (default: current month)")
    args = ap.parse_args()
    asyncio.run(_main(args.base_url, args.index, args.start, args.end))
