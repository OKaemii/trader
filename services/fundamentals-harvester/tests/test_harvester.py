"""Unit tests for the fundamentals-harvester write path (epic Task 8).

No network: every test exercises a pure function or a filesystem write against a tmp lake. The EDGAR
client is never constructed (it fails closed without a real EDGAR_USER_AGENT, by design), so these
tests cover the parsing/derivation/sentinel/atomicity logic the harvester adds on top of it:

  * the daily form-index CIK parser,
  * the `bootstrap_complete.json` sentinel gating (re-bootstrap if absent, skip if present),
  * `knowledge_ts` derivation on the SWEEP path (with acceptanceDateTime) vs the BULK path
    (None → look-ahead-safe `filed`-date fallback),
  * atomic-replace idempotency (re-writing the same CIK yields byte-equivalent file content),
  * the `/submissions` acceptance map builder + acceptance-time parsing.

The modules import bare (`import main`, `import normalize`) exactly as the deployed image runs them
(`python main.py` from `src/`); conftest puts `src/` on sys.path so the bare intra-package imports
resolve from the repo root in the gate.
"""
from __future__ import annotations

import asyncio
from datetime import date

import pyarrow.parquet as pq
import pytest

import main
import normalize
from quant_core.fundamentals.lake.calendar import derive_knowledge_ts


# --------------------------------------------------------------------------- #
# Daily form-index CIK parser                                                 #
# --------------------------------------------------------------------------- #
# A realistic slice of an EDGAR daily form.idx: a header block, the `---` rule, then fixed-ish columns
# (Form Type, Company Name, CIK, Date Filed, File Name). The parser keys on the `edgar/data/{cik}/`
# path, not the CIK column, because company names carry arbitrary whitespace.
_FORM_INDEX = """Description:           Daily Index of EDGAR Dissemination Feed by Form Type
Last Data Received:    June 11, 2026

Form Type   Company Name                                  CIK         Date Filed  File Name
---------------------------------------------------------------------------------------------
10-K        APPLE INC                                     320193      2026-06-11  edgar/data/320193/000032019326000077.txt
10-Q        MICROSOFT CORP                                789019      2026-06-11  edgar/data/789019/000078901926000099.txt
8-K         SOME OTHER CO                                 111111      2026-06-11  edgar/data/111111/000011111126000001.txt
20-F        ASML HOLDING NV                               937966      2026-06-11  edgar/data/937966/000093796626000050.txt
4           AN INSIDER                                    222222      2026-06-11  edgar/data/222222/000022222226000002.txt
10-K/A      APPLE INC                                     320193      2026-06-11  edgar/data/320193/000032019326000078.txt
"""


def test_ciks_from_form_index_keeps_only_xbrl_forms() -> None:
    ciks = main.ciks_from_form_index(_FORM_INDEX)
    # 10-K, 10-Q, 20-F, 10-K/A are in FORMS -> their CIKs are picked up.
    assert ciks == {320193, 789019, 937966}
    # 8-K and Form 4 are NOT XBRL-fact forms -> excluded.
    assert 111111 not in ciks
    assert 222222 not in ciks


def test_ciks_from_form_index_ignores_headers_and_blanks() -> None:
    assert main.ciks_from_form_index("") == set()
    assert main.ciks_from_form_index("Form Type   Company Name   CIK\n---\n\n") == set()


# --------------------------------------------------------------------------- #
# Acceptance-time parsing + the /submissions acceptance map                   #
# --------------------------------------------------------------------------- #
def test_parse_acceptance_ms_iso_z() -> None:
    # 2024-02-02T18:12:34Z -> the known epoch ms for that UTC instant.
    ms = normalize.parse_acceptance_ms("2024-02-02T18:12:34.000Z")
    assert ms == 1706897554000


def test_parse_acceptance_ms_space_separator_treated_utc() -> None:
    # An older space-separated, zoneless stamp is treated as UTC (same instant as the Z form).
    assert normalize.parse_acceptance_ms("2024-02-02 18:12:34") == 1706897554000


def test_parse_acceptance_ms_absent_or_garbage_is_none() -> None:
    assert normalize.parse_acceptance_ms(None) is None
    assert normalize.parse_acceptance_ms("") is None
    assert normalize.parse_acceptance_ms("   ") is None
    assert normalize.parse_acceptance_ms("not-a-date") is None


def test_acceptance_map_from_submissions_recent() -> None:
    subs = {
        "filings": {
            "recent": {
                "accessionNumber": ["0000320193-24-000077", "0000320193-23-000064"],
                "acceptanceDateTime": ["2024-02-02T18:12:34.000Z", "2023-11-03T16:01:00.000Z"],
            }
        }
    }
    m = main.acceptance_map(subs)
    assert m["0000320193-24-000077"] == 1706897554000
    assert "0000320193-23-000064" in m


def test_acceptance_map_empty_when_no_filings() -> None:
    assert main.acceptance_map({}) == {}
    assert main.acceptance_map({"filings": {}}) == {}
    assert main.acceptance_map({"filings": {"recent": {}}}) == {}


# --------------------------------------------------------------------------- #
# knowledge_ts on the SWEEP path (acceptance) vs the BULK path (filed)        #
# --------------------------------------------------------------------------- #
def _companyfacts(cik: int = 320193, accn: str = "0000320193-24-000077") -> dict:
    """A minimal companyfacts doc: one annual revenue fact filed after-hours Friday 2024-02-02."""
    return {
        "cik": cik,
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
                                "accn": accn,
                                "filed": "2024-02-02",
                                "frame": "CY2023",
                            }
                        ]
                    }
                }
            }
        },
    }


def test_knowledge_ts_sweep_uses_acceptance(tmp_path) -> None:
    cf = _companyfacts()
    accn = "0000320193-24-000077"
    accepted_ms = normalize.parse_acceptance_ms("2024-02-02T18:12:34.000Z")  # Fri after close
    rows = list(normalize.fact_rows(cf, {accn: accepted_ms}))
    assert len(rows) == 1
    row = rows[0]
    assert row["accepted_ts"] == accepted_ms
    # Sweep path: knowledge_ts is the precise next-session open after the exact accept instant.
    assert row["knowledge_ts"] == derive_knowledge_ts(accepted_ms, date(2024, 2, 2))
    # After-hours Friday -> NOT same-day knowable -> strictly after the accept instant (Monday open).
    assert row["knowledge_ts"] > accepted_ms


def test_knowledge_ts_bulk_falls_back_to_filed() -> None:
    cf = _companyfacts()
    # Bulk path: no acceptance map -> accepted_ts is None, knowledge_ts derives from `filed`.
    rows = list(normalize.fact_rows(cf, None))
    assert len(rows) == 1
    row = rows[0]
    assert row["accepted_ts"] is None
    assert row["knowledge_ts"] == derive_knowledge_ts(None, date(2024, 2, 2))


def test_knowledge_ts_sweep_refines_bulk_for_same_filing() -> None:
    """A later sweep (with acceptance) must SHARPEN, not loosen, the bulk-written knowledge_ts: the
    bulk filed-date fallback anchors to that day's close, the sweep to the exact accept instant — for
    an after-hours accept both roll to the same next session open here, and the sweep is never LATER
    than the bulk fallback (look-ahead-safe refinement)."""
    cf = _companyfacts()
    accn = "0000320193-24-000077"
    accepted_ms = normalize.parse_acceptance_ms("2024-02-02T18:12:34.000Z")
    bulk_kt = list(normalize.fact_rows(cf, None))[0]["knowledge_ts"]
    sweep_kt = list(normalize.fact_rows(cf, {accn: accepted_ms}))[0]["knowledge_ts"]
    assert sweep_kt <= bulk_kt


# --------------------------------------------------------------------------- #
# Atomic-replace idempotency                                                  #
# --------------------------------------------------------------------------- #
def test_write_company_facts_atomic_and_idempotent(tmp_path) -> None:
    cf = _companyfacts()
    n1 = normalize.write_company_facts(tmp_path, cf, None)
    path = tmp_path / "facts" / "cik=0000320193.parquet"
    assert path.exists()
    assert n1 == 1
    first = path.read_bytes()
    # No `.tmp` left behind (the os.replace consumed it).
    assert not list((tmp_path / "facts").glob("*.tmp"))

    # Re-writing the SAME companyfacts yields a byte-equivalent file (deterministic, idempotent).
    n2 = normalize.write_company_facts(tmp_path, cf, None)
    assert n2 == 1
    assert path.read_bytes() == first

    # The persisted row carries the 15-column lake schema with the derived knowledge_ts.
    tbl = pq.read_table(path)
    assert "knowledge_ts" in tbl.column_names
    assert "accepted_ts" in tbl.column_names
    assert tbl.column("knowledge_ts").to_pylist()[0] is not None


def test_write_company_facts_schema_columns_match_lake_contract(tmp_path) -> None:
    from quant_core.fundamentals.lake.schema import SCHEMA

    normalize.write_company_facts(tmp_path, _companyfacts(), None)
    path = tmp_path / "facts" / "cik=0000320193.parquet"
    tbl = pq.read_table(path)
    # Column ORDER + names are the on-disk contract shared with the read engine.
    assert tbl.schema.names == SCHEMA.names


# --------------------------------------------------------------------------- #
# Bootstrap-completion sentinel gating                                        #
# --------------------------------------------------------------------------- #
def test_sentinel_absent_triggers_bootstrap(tmp_path, monkeypatch) -> None:
    """main() must call bootstrap when the sentinel is absent (a fresh or crashed-partial lake)."""
    monkeypatch.setattr(main, "LAKE", tmp_path)

    called = {"bootstrap": 0}

    async def fake_bootstrap(_edgar):
        called["bootstrap"] += 1

    async def fake_sweep(_edgar):
        raise _StopLoop()  # break out of the infinite loop after one pass

    class _FakeEdgar:
        pass

    monkeypatch.setattr(main, "bootstrap", fake_bootstrap)
    monkeypatch.setattr(main, "sweep", fake_sweep)
    monkeypatch.setattr(main, "Edgar", lambda: _FakeEdgar())

    with pytest.raises(_StopLoop):
        asyncio.run(main.main())
    assert called["bootstrap"] == 1


def test_sentinel_present_skips_bootstrap(tmp_path, monkeypatch) -> None:
    """main() must SKIP bootstrap when the completion sentinel exists (a healthy prior bootstrap)."""
    monkeypatch.setattr(main, "LAKE", tmp_path)
    (tmp_path / main.SENTINEL).write_text('{"completed_at": "2026-06-12T00:00:00+00:00"}')

    called = {"bootstrap": 0}

    async def fake_bootstrap(_edgar):
        called["bootstrap"] += 1

    async def fake_sweep(_edgar):
        raise _StopLoop()

    class _FakeEdgar:
        pass

    monkeypatch.setattr(main, "bootstrap", fake_bootstrap)
    monkeypatch.setattr(main, "sweep", fake_sweep)
    monkeypatch.setattr(main, "Edgar", lambda: _FakeEdgar())

    with pytest.raises(_StopLoop):
        asyncio.run(main.main())
    assert called["bootstrap"] == 0


def test_partial_bulk_crash_leaves_no_sentinel(tmp_path, monkeypatch) -> None:
    """The CRUX of decision-note 4: a crash mid-bulk-load (a facts file written, but the bulk pass
    never completed) must NOT look 'done' — the sentinel is the only completion proof, so it is
    absent, and the next main() re-bootstraps. We simulate the partial state and assert the gate."""
    monkeypatch.setattr(main, "LAKE", tmp_path)
    # Simulate a crash: one per-CIK facts file exists, but no sentinel was written.
    normalize.write_company_facts(tmp_path, _companyfacts(), None)
    assert list((tmp_path / "facts").glob("*.parquet"))  # a partial file IS present
    assert not (tmp_path / main.SENTINEL).exists()  # but the sentinel is NOT

    called = {"bootstrap": 0}

    async def fake_bootstrap(_edgar):
        called["bootstrap"] += 1

    async def fake_sweep(_edgar):
        raise _StopLoop()

    monkeypatch.setattr(main, "bootstrap", fake_bootstrap)
    monkeypatch.setattr(main, "sweep", fake_sweep)
    monkeypatch.setattr(main, "Edgar", lambda: object())

    with pytest.raises(_StopLoop):
        asyncio.run(main.main())
    # Despite a parquet file existing, bootstrap re-runs because the sentinel is absent.
    assert called["bootstrap"] == 1


class _StopLoop(BaseException):
    """Sentinel to break main()'s infinite sweep loop in tests.

    Subclasses BaseException (NOT Exception) ON PURPOSE: main()'s loop wraps `await sweep(...)` in
    `except Exception` (so a real sweep failure is logged and the loop retries after the 30-min
    sleep). An `Exception` raised by a fake sweep would therefore be SWALLOWED — the loop would then
    hit `await asyncio.sleep(SWEEP_MINUTES * 60)` and hang the test for 30 minutes. A BaseException
    escapes that handler and aborts `asyncio.run(main.main())` cleanly, so the test asserts the
    bootstrap-gating decision (which has already happened before the first sweep) without ever
    sleeping."""
