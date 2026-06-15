"""Unit tests for Pipeline A — the harvester's 8-K Item 2.02 earnings-event extraction (Task 10).

No network: every test exercises a pure function or a tmp-lake write. The EDGAR client is never
constructed (it fails closed without a real EDGAR_USER_AGENT, by design), so these cover the
parsing/derivation/atomicity the events module adds:

  * an 8-K carrying Item 2.02 → an event-date row extracted (the earnings release),
  * a non-earnings 8-K (other items, or no item code) → ignored,
  * a non-8-K form (10-K, 4) → ignored even with a 2.02-looking items string,
  * the PIT `knowledge_ts` derivation reuses the shared next-session calendar (after-hours → next open),
  * fail-closed omission of an 8-K missing its accession / filing date,
  * atomic-replace idempotency (re-writing the same submissions doc → byte-equivalent file),
  * a 0-event CIK writes NO events file.

The modules import bare (`import events`, `import main`) exactly as the deployed image runs them
(`python main.py` from `src/`); conftest puts `src/` on sys.path so the bare intra-package imports
resolve from the repo root in the gate.
"""
from __future__ import annotations

import asyncio
from datetime import date

import pyarrow.parquet as pq
import pytest

import events
import main
import normalize
from quant_core.fundamentals.lake.calendar import derive_knowledge_ts


# --------------------------------------------------------------------------- #
# A realistic /submissions filings.recent block: parallel arrays, items included.            #
# --------------------------------------------------------------------------- #
def _submissions(
    *,
    cik: int = 320193,
    tickers=("AAPL",),
    forms=("8-K", "10-Q", "8-K", "8-K", "4"),
    items=("2.02,9.01", "", "5.02", "7.01,9.01", ""),
    filed=("2024-05-02", "2024-05-03", "2024-04-10", "2024-08-01", "2024-08-02"),
    accessions=(
        "0000320193-24-000069",
        "0000320193-24-000070",
        "0000320193-24-000061",
        "0000320193-24-000071",
        "0000320193-24-000072",
    ),
    acceptance=(
        "2024-05-02T18:30:36.000Z",  # after-hours Thursday earnings release
        "2024-05-03T06:01:00.000Z",
        "2024-04-10T16:45:00.000Z",
        "2024-08-01T18:31:00.000Z",
        "2024-08-02T10:00:00.000Z",
    ),
) -> dict:
    """A /submissions doc whose recent filings mix an earnings 8-K (Item 2.02), a 10-Q, a governance
    8-K (Item 5.02), a Reg-FD 8-K (Item 7.01), and a Form 4 — only the first is an earnings event."""
    return {
        "cik": cik,
        "tickers": list(tickers),
        "filings": {
            "recent": {
                "form": list(forms),
                "items": list(items),
                "filingDate": list(filed),
                "accessionNumber": list(accessions),
                "acceptanceDateTime": list(acceptance),
            }
        },
    }


# --------------------------------------------------------------------------- #
# Extraction — only 8-K Item 2.02 becomes an event row                        #
# --------------------------------------------------------------------------- #
def test_extracts_only_8k_item_202_earnings_event() -> None:
    rows = events.earnings_event_rows(_submissions())
    # Exactly one earnings event: the 8-K with Item 2.02. The 10-Q, the 5.02 8-K, the 7.01 8-K, and the
    # Form 4 are all excluded.
    assert len(rows) == 1
    row = rows[0]
    assert row["accession"] == "0000320193-24-000069"
    assert row["event_date"] == date(2024, 5, 2)
    assert row["cik"] == 320193
    assert row["symbol"] == "AAPL"
    assert row["source"] == events.SOURCE == "edgar-8k-item-2.02"
    assert "2.02" in row["items"]


def test_non_earnings_8k_is_ignored() -> None:
    """An 8-K with no Item 2.02 (governance / Reg-FD / material-agreement / no item code) is not an
    earnings event — none of these yield a row."""
    subs = _submissions(
        forms=("8-K", "8-K", "8-K", "8-K"),
        items=("5.02", "1.01,9.01", "7.01", ""),
        filed=("2024-03-01", "2024-03-02", "2024-03-03", "2024-03-04"),
        accessions=("a-1", "a-2", "a-3", "a-4"),
        acceptance=("2024-03-01T12:00:00.000Z",) * 4,
    )
    assert events.earnings_event_rows(subs) == []


def test_non_8k_form_with_202_items_is_ignored() -> None:
    """The form gate is on `8-K`: a 10-Q (or any non-8-K) is never an earnings EVENT even if its items
    string somehow carried 2.02 — the event is the 8-K announcement, not the periodic report."""
    subs = _submissions(
        forms=("10-Q", "10-K", "4"),
        items=("2.02", "2.02,9.01", "2.02"),
        filed=("2024-05-03", "2024-02-02", "2024-05-04"),
        accessions=("q-1", "k-1", "f-1"),
        acceptance=("2024-05-03T06:01:00.000Z", "2024-02-02T18:12:34.000Z", "2024-05-04T10:00:00.000Z"),
    )
    assert events.earnings_event_rows(subs) == []


@pytest.mark.parametrize(
    "items_str,expected",
    [
        ("2.02", True),
        ("2.02,9.01", True),
        ("9.01,2.02", True),
        ("2.02;9.01", True),       # semicolon separator
        ("2.02 9.01", True),       # space separator
        (" 2.02 , 9.01 ", True),   # whitespace-padded tokens
        ("9.01", False),
        ("5.02", False),
        ("", False),
        (None, False),
        ("12.02", False),          # exact-token match: not a substring of a longer code
        ("2.020", False),
    ],
)
def test_items_have_earnings_token_matching(items_str, expected) -> None:
    assert events._items_have_earnings(items_str) is expected


# --------------------------------------------------------------------------- #
# PIT knowledge_ts — reuses the shared next-session calendar                  #
# --------------------------------------------------------------------------- #
def test_event_knowledge_ts_uses_acceptance_next_session() -> None:
    """An after-hours earnings 8-K is knowable only the NEXT session open — the event's knowledge_ts is
    the SAME derivation the facts use (shared calendar), strictly after the accept instant."""
    rows = events.earnings_event_rows(_submissions())
    row = rows[0]
    accepted_ms = normalize.parse_acceptance_ms("2024-05-02T18:30:36.000Z")
    assert row["accepted_ts"] == accepted_ms
    assert row["knowledge_ts"] == derive_knowledge_ts(accepted_ms, date(2024, 5, 2))
    # 18:30 ET Thursday is after the 16:00 close → knowable Friday's open, strictly later than accept.
    assert row["knowledge_ts"] > accepted_ms


def test_event_knowledge_ts_falls_back_to_filed_when_acceptance_absent() -> None:
    """A recent 8-K row with no acceptanceDateTime still gets a non-null knowledge_ts from the filing
    date's close (the look-ahead-safe fallback) — never crashes, never null."""
    subs = _submissions(
        forms=("8-K",),
        items=("2.02",),
        filed=("2024-05-02",),
        accessions=("0000320193-24-000069",),
        acceptance=("",),  # no acceptance time on this row
    )
    rows = events.earnings_event_rows(subs)
    assert len(rows) == 1
    row = rows[0]
    assert row["accepted_ts"] is None
    assert row["knowledge_ts"] == derive_knowledge_ts(None, date(2024, 5, 2))
    assert row["knowledge_ts"] is not None


# --------------------------------------------------------------------------- #
# Fail-closed omission — a non-null column can't be populated → row dropped    #
# --------------------------------------------------------------------------- #
def test_drops_event_missing_accession_or_filing_date() -> None:
    """An 8-K Item 2.02 row missing its accession OR its filing date can't populate the non-null
    EVENT_SCHEMA columns, so it is DROPPED (never written as a null that would abort the per-CIK write).
    A good row in the same doc still lands."""
    subs = _submissions(
        forms=("8-K", "8-K", "8-K"),
        items=("2.02", "2.02", "2.02,9.01"),
        filed=("", "2024-05-02", "2024-08-01"),  # first row: no filing date → dropped
        accessions=("good-but-no-date", "", "0000320193-24-000071"),  # second: no accession → dropped
        acceptance=("2024-05-01T18:00:00.000Z",) * 3,
    )
    rows = events.earnings_event_rows(subs)
    assert len(rows) == 1
    assert rows[0]["accession"] == "0000320193-24-000071"


def test_empty_or_missing_filings_block_yields_no_rows() -> None:
    assert events.earnings_event_rows({}) == []
    assert events.earnings_event_rows({"cik": 1, "filings": {}}) == []
    assert events.earnings_event_rows({"cik": 1, "filings": {"recent": {}}}) == []


def test_duplicate_accession_deduped() -> None:
    """A defensive dedupe on accession — the same earnings 8-K appearing twice yields a single row."""
    subs = _submissions(
        forms=("8-K", "8-K"),
        items=("2.02", "2.02,9.01"),
        filed=("2024-05-02", "2024-05-02"),
        accessions=("dup-accn", "dup-accn"),
        acceptance=("2024-05-02T18:30:36.000Z", "2024-05-02T18:30:36.000Z"),
    )
    rows = events.earnings_event_rows(subs)
    assert len(rows) == 1


# --------------------------------------------------------------------------- #
# Atomic-replace write — idempotent, one file per CIK, schema-correct          #
# --------------------------------------------------------------------------- #
def test_write_earnings_events_atomic_and_idempotent(tmp_path) -> None:
    n1 = events.write_earnings_events(tmp_path, _submissions())
    path = tmp_path / "events" / "cik=0000320193.parquet"
    assert n1 == 1
    assert path.exists()
    first = path.read_bytes()
    # No `.tmp` left behind (os.replace consumed it).
    assert not list((tmp_path / "events").glob("*.tmp"))

    # Re-writing the SAME submissions doc yields a byte-equivalent file (deterministic, idempotent).
    n2 = events.write_earnings_events(tmp_path, _submissions())
    assert n2 == 1
    assert path.read_bytes() == first

    # Schema columns are the events store contract.
    tbl = pq.read_table(path)
    assert tbl.schema.names == events.EVENT_SCHEMA.names
    assert tbl.num_rows == 1
    for col in ("cik", "event_date", "accession", "knowledge_ts", "source"):
        assert tbl.column(col).null_count == 0
    assert tbl.column("event_date").to_pylist()[0] == date(2024, 5, 2)


def test_write_earnings_events_no_earnings_writes_no_file(tmp_path) -> None:
    """A CIK with no Item-2.02 8-K in its recent window writes NO events file (0 rows) — the common
    steady state, not an empty parquet the reader must special-case."""
    subs = _submissions(
        forms=("10-Q", "8-K"),
        items=("", "5.02"),
        filed=("2024-05-03", "2024-04-10"),
        accessions=("q-1", "g-1"),
        acceptance=("2024-05-03T06:01:00.000Z", "2024-04-10T16:45:00.000Z"),
    )
    n = events.write_earnings_events(tmp_path, subs)
    assert n == 0
    assert not (tmp_path / "events").exists() or not list((tmp_path / "events").glob("*.parquet"))


def test_write_earnings_events_no_current_ticker_still_records(tmp_path) -> None:
    """A delisted/no-current-ticker CIK still records its events keyed by CIK; `symbol` is null."""
    subs = _submissions(tickers=())
    n = events.write_earnings_events(tmp_path, subs)
    assert n == 1
    tbl = pq.read_table(tmp_path / "events" / "cik=0000320193.parquet")
    assert tbl.column("symbol").to_pylist()[0] is None
    assert tbl.column("cik").to_pylist()[0] == 320193


# --------------------------------------------------------------------------- #
# refresh_cik wiring — the sweep path persists events from the submissions doc #
# --------------------------------------------------------------------------- #
def test_refresh_cik_writes_events_from_submissions(tmp_path, monkeypatch) -> None:
    """`main.refresh_cik` extracts earnings events from the SAME /submissions doc it already fetches for
    the acceptance map — no extra EDGAR call. We fake the Edgar client (no network, no UA guard) and
    assert the per-CIK events file lands alongside the facts file."""
    monkeypatch.setattr(main, "LAKE", tmp_path)

    cf = {
        "cik": 320193,
        "facts": {
            "us-gaap": {
                "Revenues": {
                    "units": {
                        "USD": [
                            {
                                "start": "2023-01-01",
                                "end": "2023-12-31",
                                "val": 383285000000,
                                "fy": 2023,
                                "fp": "FY",
                                "form": "10-K",
                                "accn": "0000320193-24-000077",
                                "filed": "2024-02-02",
                                "frame": "CY2023",
                            }
                        ]
                    }
                }
            }
        },
    }
    subs = _submissions()

    class _FakeEdgar:
        async def companyfacts(self, cik):
            return cf

        async def submissions(self, cik):
            return subs

    out = asyncio.run(main.refresh_cik(_FakeEdgar(), 320193))
    assert out is subs  # returns the submissions doc for the entity upsert
    # Both stores written from the one refresh.
    assert (tmp_path / "facts" / "cik=0000320193.parquet").exists()
    ev_path = tmp_path / "events" / "cik=0000320193.parquet"
    assert ev_path.exists()
    tbl = pq.read_table(ev_path)
    assert tbl.num_rows == 1
    assert tbl.column("accession").to_pylist()[0] == "0000320193-24-000069"
