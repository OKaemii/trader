"""companyfacts JSON -> per-CIK PIT Parquet rows (the lake write path).

One Parquet file per CIK. The unit of refresh equals the unit of storage, so a refresh is a single
atomic file replace — idempotent by construction (re-writing the same companyfacts yields a
byte-equivalent fact set, so a reader never observes a half-written file).

Every row keeps the period axis AND the derived availability:
  * start / end     -> the fiscal period the value describes (start NULL for instant facts).
  * filed           -> the SEC filing DATE (coarse, day-granularity).
  * accepted_ts     -> the EDGAR acceptanceDateTime (UTC ms), per accession — present on the sweep
                       path (which fetches /submissions), absent (None) on the bulk-zip bootstrap.
  * knowledge_ts    -> DERIVED, non-null: the next NYSE session OPEN after accepted_ts (or, on the
                       bulk path, after filed's close) — the PIT read axis. The read filter is
                       `knowledge_ts <= :as_of`, so a fact accepted after the close becomes knowable
                       only at the next session's open (never look-ahead).

The schema (15-column on-disk contract) and the knowledge_ts derivation are imported from quant-core
(`quant_core.fundamentals.lake.{schema,calendar}`) — the SINGLE source of truth shared with the
DuckDB read engine and backtest replay, so writer and reader cannot drift on column order, types, or
the next-session calendar. Restatements/amendments (a 10-K/A) simply add rows with a later
knowledge_ts; nothing is ever overwritten, which is what makes as-of queries correct.
"""
from __future__ import annotations

import os
from datetime import date, datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

# The on-disk contract + the knowledge_ts derivation live in quant-core (the read engine reads the
# same SCHEMA; the live write-path and replay read-path share ONE next-session calendar — see Tasks
# 2/3 release notes). Do NOT redefine either here.
from quant_core.fundamentals.lake.calendar import derive_knowledge_ts
from quant_core.fundamentals.lake.schema import SCHEMA


def _d(s: str | None) -> date | None:
    return date.fromisoformat(s) if s else None


def parse_acceptance_ms(raw: str | None) -> int | None:
    """Parse an EDGAR `acceptanceDateTime` to a UTC-ms epoch, or None when absent/unparseable.

    EDGAR stamps acceptance as an ISO-8601 instant — modern `/submissions` uses
    `2024-02-02T18:12:34.000Z` (the trailing `Z` = UTC); some older feeds use a space separator
    (`2024-02-02 18:12:34`) with no zone, which we treat as UTC (EDGAR acceptance is published in
    Eastern by SEC but the `/submissions` `acceptanceDateTime` field is already the canonical instant
    the calendar consumes as UTC ms — the next-session derivation converts to ET internally). A value
    that does not parse degrades to None → the bulk `filed`-date fallback, never a crash."""
    if not raw or not raw.strip():
        return None
    s = raw.strip().replace(" ", "T", 1)
    # `datetime.fromisoformat` on 3.12 accepts the trailing `Z`; guard older variants defensively.
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def fact_rows(cf: dict, accepted_by_accession: dict[str, int] | None = None):
    """Yield normalized PIT rows from one companyfacts document.

    `accepted_by_accession` maps an accession number → its acceptance UTC ms (from `/submissions`,
    the sweep path). When a fact's accession is present there, its `accepted_ts` is the exact
    acceptance instant and `knowledge_ts` is the precise next-session open; otherwise `accepted_ts`
    is None (the bulk-bootstrap path) and `knowledge_ts` falls back to the look-ahead-safe next
    session after the SEC `filed` date's close. Both columns are written either way.
    """
    accepted_by_accession = accepted_by_accession or {}
    cik = int(cf["cik"])
    seen: set[tuple] = set()
    for taxonomy, concepts in (cf.get("facts") or {}).items():
        for concept, body in concepts.items():
            for unit, observations in (body.get("units") or {}).items():
                for o in observations:
                    # FAIL-CLOSED OMISSION: the lake SCHEMA marks `value`, `end`, `accession`,
                    # `filed`, `fy`, `fp`, `form` as nullable=False (the read-axis + period-frame +
                    # lineage columns). EDGAR does NOT guarantee all of them on every observation —
                    # the reference parser (services/fundamentals-ingestion/src/download/edgar.py)
                    # `continue`s on a missing `end`/`accn`/`fp`/`form` for exactly this reason. A
                    # row that can't populate a required column would make `Table.from_pylist(...,
                    # schema=SCHEMA)` raise ArrowInvalid and abort the WHOLE per-CIK write (and, on
                    # the unguarded bulk path, the whole bootstrap). So DROP the one incomplete fact
                    # — never a fabricated value, never a vanished CIK. `start`/`accepted_ts`/`frame`
                    # are the only nullable columns and are passed through as-is.
                    val = o.get("val")
                    end = o.get("end")
                    accn = o.get("accn")
                    filed_raw = o.get("filed")
                    fy = o.get("fy")
                    fp = o.get("fp")
                    form = o.get("form")
                    if (
                        val is None
                        or not end
                        or not accn
                        or not filed_raw
                        or fy is None
                        or not fp
                        or not form
                    ):
                        continue
                    key = (taxonomy, concept, unit, o.get("start"), end, accn)
                    if key in seen:
                        continue
                    seen.add(key)
                    filed = _d(filed_raw)
                    accepted_ts = accepted_by_accession.get(accn)
                    yield {
                        "cik": cik,
                        "taxonomy": taxonomy,
                        "concept": concept,
                        "unit": unit,
                        "start": _d(o.get("start")),
                        "end": _d(end),
                        "value": float(val),
                        "fy": int(fy),
                        "fp": fp,
                        "form": form,
                        "accession": accn,
                        "filed": filed,
                        "accepted_ts": accepted_ts,
                        "knowledge_ts": derive_knowledge_ts(accepted_ts, filed),
                        "frame": o.get("frame"),
                    }


def write_company_facts(
    lake: Path,
    cf: dict,
    accepted_by_accession: dict[str, int] | None = None,
) -> int:
    """Atomically (re)write the per-CIK fact file with derived knowledge_ts. Returns row count.

    Writes `facts/cik=<cik:010d>.parquet` via tmpfile + `os.replace` — a reader opening the file
    mid-refresh sees the OLD file until the POSIX-atomic swap (no torn read). The unit of refresh is
    the whole per-CIK file, so a later sweep that supplies `accepted_by_accession` re-derives the
    sharper `knowledge_ts` for every row in one replace (the bulk-written file is overwritten, not
    appended to).
    """
    rows = list(fact_rows(cf, accepted_by_accession))
    out = lake / "facts"
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"cik={int(cf['cik']):010d}.parquet"
    table = pa.Table.from_pylist(rows, schema=SCHEMA)
    tmp = path.with_suffix(".parquet.tmp")
    pq.write_table(table, tmp, compression="zstd")
    os.replace(tmp, path)  # readers never observe a half-written file
    return len(rows)
