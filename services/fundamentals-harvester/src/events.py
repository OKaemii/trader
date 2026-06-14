"""Pipeline A — historical earnings EVENT dates from EDGAR 8-K Item 2.02 (the lake event store).

The true earnings-announcement date is the **8-K Item 2.02** ("Results of Operations and Financial
Condition" — the earnings press release), NOT the 10-Q/10-K. The 8-K precedes the periodic report by
days–weeks and is what the market reacts to, so any future consensus-based SUE/PEAD windowing must key
its event window off this date. This module extracts those dates and persists them keyed per CIK,
mirroring the per-CIK Parquet lake the rest of the harvester writes — so the unit of refresh equals the
unit of storage and a refresh is a single atomic file replace.

WHY `/submissions`, not the daily form index or a new endpoint. The daily `form.idx` carries only the
form TYPE (`8-K`), never the item codes — so it cannot distinguish an earnings 8-K (Item 2.02) from a
governance 8-K (Item 5.02), a material-agreement 8-K (Item 1.01), etc. The EDGAR `/submissions` doc,
which the sweep ALREADY fetches per filed CIK (`main.refresh_cik`), carries `filings.recent` parallel
arrays INCLUDING an `items` column (e.g. `"2.02,9.01"`). Filtering `form == '8-K'` ∧ `'2.02' ∈ items`
off the doc the harvester already has in hand is the rate-budget-free, model-consistent source — no
extra EDGAR request, behind the same shared `EDGAR_REQS_PER_SEC` limiter, fail-closed on the same
EDGAR_USER_AGENT guard (the Edgar client refuses to construct without a real UA, so a no-UA run fetches
no `/submissions` and writes no events).

PIT, like every other lake write. Each event keeps the same dual-timestamp axis the facts do:
  * `event_date`   — the SEC filing DATE of the 8-K (day-granularity) — the announcement date itself.
  * `accepted_ts`  — the EDGAR acceptanceDateTime (UTC ms) for the 8-K accession, when present.
  * `knowledge_ts` — DERIVED, non-null: the next NYSE session OPEN after `accepted_ts` (or, absent it,
                     after `event_date`'s close) via the SAME `derive_knowledge_ts` the facts use — so
                     an after-hours earnings 8-K is "knowable" only next session, never look-ahead.
Restatements/dupes are idempotent: the whole per-CIK events file is rewritten on each refresh, and a
(cik, accession) is unique, so re-processing the same submissions doc yields a byte-equivalent file.

The row shape the card pins — `{cik, symbol, event_date, accession, source}` — plus the PIT columns
(`items`, `accepted_ts`, `knowledge_ts`) the lake convention requires. `source` is the literal
`'edgar-8k-item-2.02'` provenance stamp (mirroring the facts' `pit-edgar` lineage).
"""
from __future__ import annotations

import os
from datetime import date
from pathlib import Path
from typing import Optional

import pyarrow as pa
import pyarrow.parquet as pq

# Reuse the SINGLE next-session knowledge calendar the facts write-path + the read engine share, so an
# earnings event's availability instant is derived identically to a fundamental fact's (no drift).
from quant_core.fundamentals.lake.calendar import derive_knowledge_ts
from normalize import parse_acceptance_ms

# The 8-K item code for "Results of Operations and Financial Condition" — the earnings release. This is
# the one item that marks an earnings announcement; an 8-K filed for any other reason (1.01 entry into a
# material agreement, 5.02 officer departure, 7.01 Reg FD disclosure, …) is NOT an earnings event.
EARNINGS_ITEM = "2.02"

# Provenance stamp written on every event row — the Pipeline A lineage, mirroring the facts' source tag.
SOURCE = "edgar-8k-item-2.02"

# The events store schema (one Parquet file per CIK at `events/cik=<cik:010d>.parquet`). `knowledge_ts`
# is non-null (the PIT read axis, always derivable from event_date); `accepted_ts` is nullable (absent
# when the submissions doc lacked an acceptanceDateTime for that accession). `symbol` is nullable — a
# convenience field; the CIK is the authoritative key and a CIK with no current ticker (a delisted
# filer) still records its events.
EVENT_SCHEMA = pa.schema(
    [
        ("cik", pa.int32()),
        ("symbol", pa.string()),       # current primary ticker (convenience; CIK is the key)
        ("event_date", pa.date32()),   # the 8-K filing date — the earnings-announcement date
        ("accession", pa.string()),    # the 8-K accession number (unique per filing)
        ("items", pa.string()),        # the raw EDGAR items string for the 8-K (e.g. "2.02,9.01")
        ("accepted_ts", pa.int64()),   # EDGAR acceptanceDateTime UTC ms (nullable — sweep path only)
        ("knowledge_ts", pa.int64()),  # next NYSE session open after acceptance/close (non-null PIT axis)
        ("source", pa.string()),       # provenance: 'edgar-8k-item-2.02'
    ]
)


def _d(s: str | None) -> date | None:
    return date.fromisoformat(s) if s else None


def _items_have_earnings(items: str | None) -> bool:
    """True iff the 8-K's `items` string contains Item 2.02.

    EDGAR packs an 8-K's items as a comma-separated string (`"2.02,9.01"`); occasional feeds use a
    space or semicolon separator, so split on any of them. A match is on the EXACT `2.02` token (not a
    substring) so a stray longer value can't false-positive on the `2.02` substring. An absent/empty
    items string is NOT an earnings 8-K (a current report filed with no item code is never an earnings
    release)."""
    if not items:
        return False
    tokens = items.replace(";", ",").replace(" ", ",").split(",")
    return EARNINGS_ITEM in {t.strip() for t in tokens if t.strip()}


def earnings_event_rows(subs: dict) -> list[dict]:
    """Extract Item-2.02 8-K earnings-event rows from one EDGAR `/submissions` doc, newest-first as the
    feed orders them.

    Reads `filings.recent`'s parallel arrays (`form`, `items`, `filingDate`, `accessionNumber`,
    `acceptanceDateTime`) — the same block `main.acceptance_map` reads. A filing is an earnings event
    iff `form == '8-K'` ∧ Item 2.02 ∈ items. Each kept row carries `event_date` (the 8-K filing date),
    `accepted_ts` (parsed acceptance ms, or None), and a DERIVED `knowledge_ts` (the next-session open).

    FAIL-CLOSED OMISSION (mirrors `normalize.fact_rows`): the EVENT_SCHEMA marks `event_date`,
    `accession`, `knowledge_ts`, `source` as non-null. EDGAR does not guarantee `filingDate`/
    `accessionNumber` on every recent row, so an 8-K missing either is DROPPED (never written as a null
    that would make `Table.from_pylist(..., schema=EVENT_SCHEMA)` raise ArrowInvalid and abort the
    whole per-CIK events write). `accepted_ts` may legitimately be None (older filings) — passed through.

    `filings.files` (the older paged history beyond `recent`) is NOT walked here, exactly as
    `acceptance_map` doesn't: the sweep targets fresh filings, and a deep backfill of decades-old 8-K
    item codes is not worth N extra requests per CIK. Each sweep extends the per-CIK events file with
    whatever the current `recent` window holds; the file is rewritten wholesale (idempotent) so a
    re-seen accession does not duplicate.
    """
    recent = (subs.get("filings") or {}).get("recent") or {}
    forms = recent.get("form") or []
    items = recent.get("items") or []
    filed = recent.get("filingDate") or []
    accns = recent.get("accessionNumber") or []
    accepted = recent.get("acceptanceDateTime") or []

    cik_raw = subs.get("cik")
    cik = int(cik_raw) if cik_raw is not None and str(cik_raw).strip() != "" else None
    symbol = _primary_ticker(subs)

    out: list[dict] = []
    seen: set[str] = set()
    for i, form in enumerate(forms):
        if form != "8-K":
            continue
        it = items[i] if i < len(items) else None
        if not _items_have_earnings(it):
            continue
        accn = accns[i] if i < len(accns) else None
        event_date = _d(filed[i] if i < len(filed) else None)
        # Fail-closed: an 8-K missing its accession or filing date can't populate the non-null columns.
        if not accn or event_date is None:
            continue
        if accn in seen:  # a filing only carries one items string; dedupe defensively
            continue
        seen.add(accn)
        accepted_ts = parse_acceptance_ms(accepted[i] if i < len(accepted) else None)
        out.append(
            {
                "cik": cik,
                "symbol": symbol,
                "event_date": event_date,
                "accession": accn,
                "items": it,
                "accepted_ts": accepted_ts,
                "knowledge_ts": derive_knowledge_ts(accepted_ts, event_date),
                "source": SOURCE,
            }
        )
    return out


def _primary_ticker(subs: dict) -> Optional[str]:
    """The entity's current primary ticker from a `/submissions` doc, or None.

    `/submissions` carries `tickers` (a list of current symbols); the first is the primary listing. A
    delisted/private filer (or a fund) may carry none — then None, and the CIK alone keys the event (the
    convenience symbol is allowed to be absent)."""
    tickers = subs.get("tickers") or []
    if tickers and isinstance(tickers, list) and tickers[0]:
        return str(tickers[0]).upper()
    return None


def write_earnings_events(lake: Path, subs: dict) -> int:
    """Atomically (re)write one CIK's `events/cik=<cik:010d>.parquet` from its `/submissions` doc.

    Returns the number of earnings-event rows persisted (0 when the CIK filed no Item-2.02 8-K in the
    `recent` window — e.g. a company between earnings, or a non-operating filer). A 0-row CIK writes NO
    file (an empty events file would just be noise the reader has to special-case); the caller treats a
    0 return as "no earnings events this refresh", which is the common steady state.

    Writes via tmpfile + `os.replace` (POSIX-atomic) so a reader never observes a half-written file —
    the same durability contract as `normalize.write_company_facts` and the identity writers. The unit
    of refresh is the whole per-CIK file, so a later sweep that sees a new earnings 8-K rewrites the file
    with the extended set (idempotent: a re-seen accession is deduped, identical input → identical bytes).
    """
    rows = earnings_event_rows(subs)
    if not rows:
        return 0
    out = lake / "events"
    out.mkdir(parents=True, exist_ok=True)
    cik = int(rows[0]["cik"]) if rows[0]["cik"] is not None else int(subs["cik"])
    path = out / f"cik={cik:010d}.parquet"
    table = pa.Table.from_pylist(rows, schema=EVENT_SCHEMA)
    tmp = path.with_suffix(".parquet.tmp")
    pq.write_table(table, tmp, compression="zstd")
    os.replace(tmp, path)  # readers never observe a half-written file
    return len(rows)
