"""Tests for the PIT-lake DuckDB store (epic Task 5) — `quant_core.fundamentals.lake.store.Store`.

The store is the read engine: it answers "what was knowable about this CIK as of `T`" with no
look-ahead, by filtering the per-CIK Parquet file on the DERIVED `knowledge_ts` availability axis
(not the coarse SEC `filed` date) and keeping the latest-known revision per fiscal period. These
tests pin the four behaviours the whole PIT guarantee rests on, over a SYNTHETIC 2-CIK lake built
with the real Task-3 `SCHEMA` (so the column contract the harvester writes is exercised end-to-end):

  1. **Restatement supersede (the headline guarantee).** A name files a first-print FY value, then
     RESTATES it in a later amendment (an extra row, later `knowledge_ts`). An as-of read BEFORE the
     restatement's knowledge instant returns the FIRST PRINT; an as-of read AFTER returns the
     RESTATED value. Nothing is overwritten — `row_number() OVER (… ORDER BY knowledge_ts DESC)`
     does the superseding at read time.
  2. **`knowledge_ts` cutoff excludes not-yet-known rows.** An as-of strictly before a fact's
     `knowledge_ts` does not see it at all (the look-ahead guard, in SQL).
  3. **Rename resolves through the stable CIK.** A ticker rename (OLDT→NEWT, FB→META style) means the
     old symbol at an old date and the new symbol today both resolve to the SAME CIK, so history is
     continuous across the rename. Asking for the OLD symbol TODAY (its window closed at the rename)
     falls back to its most recent era rather than dead-ending.
  4. **Graceful degradation.** A missing CIK file → `[]`; a non-US market → `resolve` returns None
     (no EDGAR); a cold lake (no files at all) constructs and reads without crashing.

pyarrow + duckdb are the `quant-core[lake]` extra — the docker gate installs `[lake]`, so this suite
runs there; locally it `importorskip`s both so the rest of the quant-core suite still collects where
they are absent. The fixtures write the SAME on-disk shapes the harvester produces: per-CIK facts via
the Task-3 `SCHEMA`, plus `ticker_history.parquet` (cik, ticker, valid_from, valid_to) and
`entities.parquet` (cik, name, sic, sic_desc, exchanges, tickers, former_names).
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")
pytest.importorskip("duckdb")

from quant_core.fundamentals.lake.schema import SCHEMA  # noqa: E402
from quant_core.fundamentals.lake.store import Store  # noqa: E402

# ticker_history / entities schemas mirror the harvester's writers (identity.py); the store reads
# these columns by name. Kept local to the test so the synthetic lake is the EXACT on-disk shape.
_TICKER_SCHEMA = pa.schema(
    [
        ("cik", pa.int32()),
        ("ticker", pa.string()),
        ("valid_from", pa.date32()),
        ("valid_to", pa.date32()),  # null = currently listed under this symbol
    ]
)
_ENTITY_SCHEMA = pa.schema(
    [
        ("cik", pa.int32()),
        ("name", pa.string()),
        ("sic", pa.string()),
        ("sic_desc", pa.string()),
        ("exchanges", pa.string()),     # JSON list
        ("tickers", pa.string()),       # JSON list
        ("former_names", pa.string()),  # JSON list of {name, from, to}
    ]
)

# Two CIKs in the synthetic lake.
CIK_ACME = 999          # files + restates FY revenue; renamed OLDT -> NEWT
CIK_OTHER = 1234        # a second, independent name (proves per-CIK file targeting isolates reads)


def _ms(y: int, mo: int, d: int, h: int = 14, mi: int = 30) -> int:
    """A UTC wall-clock instant as a UTC-ms epoch — the unit `knowledge_ts` (and `as_of_ms`) use.
    Default 14:30 UTC ≈ 09:30 ET (a session open) but the exact wall-time is immaterial here; the
    tests assert ordering relative to these chosen knowledge instants, not calendar derivation."""
    return int(datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp() * 1000)


def _fact(
    *,
    cik: int,
    concept: str,
    value: float,
    end: str,
    knowledge_ts: int,
    accession: str,
    start: str | None = None,
    taxonomy: str = "us-gaap",
    unit: str = "USD",
    fy: int = 2023,
    fp: str = "FY",
    form: str = "10-K",
    filed: str = "2024-02-15",
    accepted_ts: int | None = None,
    frame: str | None = None,
) -> dict:
    """One fact row in the Task-3 SCHEMA shape (dates as `date`, ms axes as int)."""
    return {
        "cik": cik,
        "taxonomy": taxonomy,
        "concept": concept,
        "unit": unit,
        "start": date.fromisoformat(start) if start else None,
        "end": date.fromisoformat(end),
        "value": float(value),
        "fy": fy,
        "fp": fp,
        "form": form,
        "accession": accession,
        "filed": date.fromisoformat(filed),
        "accepted_ts": accepted_ts,
        "knowledge_ts": knowledge_ts,
        "frame": frame,
    }


def _write_facts(lake: Path, cik: int, rows: list[dict]) -> None:
    """Write the per-CIK fact file at the canonical `facts/cik=<cik:010d>.parquet` path (the name the
    store targets), using the real Task-3 SCHEMA."""
    out = lake / "facts"
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"cik={int(cik):010d}.parquet"
    pq.write_table(pa.Table.from_pylist(rows, schema=SCHEMA), path, compression="zstd")


def _write_ticker_history(lake: Path, rows: list[dict]) -> None:
    pq.write_table(
        pa.Table.from_pylist(rows, schema=_TICKER_SCHEMA),
        lake / "ticker_history.parquet",
        compression="zstd",
    )


def _write_entities(lake: Path, rows: list[dict]) -> None:
    pq.write_table(
        pa.Table.from_pylist(rows, schema=_ENTITY_SCHEMA),
        lake / "entities.parquet",
        compression="zstd",
    )


# Knowledge instants used across the restatement tests (chosen so each is its own distinct cutoff).
FIRST_PRINT_KTS = _ms(2024, 2, 16)   # FY2023 10-K becomes knowable
RESTATE_KTS = _ms(2024, 8, 12)       # the 10-K/A restatement becomes knowable (later)


@pytest.fixture()
def lake(tmp_path: Path) -> Path:
    """A synthetic 2-CIK lake.

    CIK_ACME (renamed OLDT->NEWT on 2023-06-01):
      * FY2023 Revenues first-printed at 400 (knowable FIRST_PRINT_KTS), then RESTATED to 402 in a
        10-K/A (knowable RESTATE_KTS) — same fiscal period, later knowledge_ts.
      * an instant Assets=1500 at 2023-12-31 (knowable FIRST_PRINT_KTS).
    CIK_OTHER: a single independent FY2023 Revenues=777, so a read of one CIK never picks up the other
      (per-CIK file targeting).
    """
    root = tmp_path / "lake"
    root.mkdir()
    _write_facts(root, CIK_ACME, [
        # first print, then restatement of the SAME (start,end) period at a later knowledge_ts
        _fact(cik=CIK_ACME, concept="Revenues", value=400, start="2023-01-01", end="2023-12-31",
              knowledge_ts=FIRST_PRINT_KTS, accession="A4", form="10-K", filed="2024-02-15"),
        _fact(cik=CIK_ACME, concept="Revenues", value=402, start="2023-01-01", end="2023-12-31",
              knowledge_ts=RESTATE_KTS, accession="A5", form="10-K/A", filed="2024-08-10"),
        # an instant (balance-sheet) fact — no `start`
        _fact(cik=CIK_ACME, concept="Assets", value=1500, start=None, end="2023-12-31",
              knowledge_ts=FIRST_PRINT_KTS, accession="A4", form="10-K", filed="2024-02-15"),
    ])
    _write_facts(root, CIK_OTHER, [
        _fact(cik=CIK_OTHER, concept="Revenues", value=777, start="2023-01-01", end="2023-12-31",
              knowledge_ts=FIRST_PRINT_KTS, accession="B1", form="10-K", filed="2024-02-20"),
    ])
    _write_ticker_history(root, [
        # OLDT listed 2020-01-01 .. 2023-06-01, then renamed to NEWT (still live). Same CIK throughout.
        {"cik": CIK_ACME, "ticker": "OLDT", "valid_from": date(2020, 1, 1), "valid_to": date(2023, 6, 1)},
        {"cik": CIK_ACME, "ticker": "NEWT", "valid_from": date(2023, 6, 1), "valid_to": None},
        {"cik": CIK_OTHER, "ticker": "OTHR", "valid_from": date(2019, 1, 1), "valid_to": None},
    ])
    _write_entities(root, [
        {"cik": CIK_ACME, "name": "Acme Corp", "sic": "7372", "sic_desc": "Prepackaged Software",
         "exchanges": json.dumps(["NYSE"]), "tickers": json.dumps(["NEWT"]),
         "former_names": json.dumps([{"name": "OldCo", "from": "2020-01-01", "to": "2023-06-01"}])},
        {"cik": CIK_OTHER, "name": "Other Inc", "sic": "1234", "sic_desc": "Things",
         "exchanges": json.dumps(["NASDAQ"]), "tickers": json.dumps(["OTHR"]),
         "former_names": json.dumps([])},
    ])
    return root


# --------------------------------------------------------------------------------------------------- #
# 1. Restatement supersede + 2. knowledge_ts cutoff                                                    #
# --------------------------------------------------------------------------------------------------- #
def test_as_of_at_first_print_returns_first_print(lake: Path) -> None:
    """An as-of read at the first-print knowledge instant returns the FIRST PRINT (400), even though a
    later restatement to 402 exists in the file — the restatement's knowledge_ts is in the future."""
    s = Store(lake)
    rows = s.pit_series(CIK_ACME, "us-gaap", "Revenues", "USD", FIRST_PRINT_KTS, instant=False)
    assert len(rows) == 1
    assert rows[0]["value"] == 400.0
    assert rows[0]["accession"] == "A4"
    assert rows[0]["form"] == "10-K"
    # the row carries the fields metric_series consumes (filed + knowledge_ts provenance)
    assert rows[0]["filed"] == date(2024, 2, 15)
    assert rows[0]["knowledge_ts"] == FIRST_PRINT_KTS


def test_as_of_after_restatement_returns_restated_value(lake: Path) -> None:
    """An as-of read after the restatement is knowable returns the RESTATED value (402) — the later
    knowledge_ts wins at read time (row_number ORDER BY knowledge_ts DESC), nothing was overwritten."""
    s = Store(lake)
    rows = s.pit_series(CIK_ACME, "us-gaap", "Revenues", "USD", RESTATE_KTS, instant=False)
    assert len(rows) == 1  # still ONE row per fiscal period — the restatement supersedes, not appends
    assert rows[0]["value"] == 402.0
    assert rows[0]["accession"] == "A5"
    assert rows[0]["form"] == "10-K/A"


def test_knowledge_ts_cutoff_excludes_not_yet_known_rows(lake: Path) -> None:
    """An as-of strictly before any fact's knowledge_ts sees NOTHING (the look-ahead guard) — even
    one millisecond before the first print is knowable."""
    s = Store(lake)
    rows = s.pit_series(CIK_ACME, "us-gaap", "Revenues", "USD", FIRST_PRINT_KTS - 1, instant=False)
    assert rows == []


def test_as_of_between_prints_excludes_the_restatement(lake: Path) -> None:
    """Between the first print and the restatement, only the first print is known (the restatement's
    knowledge_ts is still in the future) — the cutoff is exclusive of not-yet-known rows."""
    s = Store(lake)
    mid = RESTATE_KTS - 1
    rows = s.pit_series(CIK_ACME, "us-gaap", "Revenues", "USD", mid, instant=False)
    assert len(rows) == 1
    assert rows[0]["value"] == 400.0


def test_instant_fact_partitions_on_end_only(lake: Path) -> None:
    """An instant (balance-sheet) query partitions on `end` alone (the fact has no `start`) and still
    PIT-filters; the Assets=1500 instant resolves at/after its knowledge instant."""
    s = Store(lake)
    rows = s.pit_series(CIK_ACME, "us-gaap", "Assets", "USD", FIRST_PRINT_KTS, instant=True)
    assert len(rows) == 1
    assert rows[0]["value"] == 1500.0
    assert rows[0]["start"] is None
    assert rows[0]["end"] == date(2023, 12, 31)


def test_pit_series_targets_one_cik_only(lake: Path) -> None:
    """A read of CIK_ACME never returns CIK_OTHER's rows — the hot path targets the single per-CIK
    file, so there is no cross-CIK fan-out. (CIK_OTHER's Revenues=777 must not leak in.)"""
    s = Store(lake)
    acme = s.pit_series(CIK_ACME, "us-gaap", "Revenues", "USD", RESTATE_KTS, instant=False)
    other = s.pit_series(CIK_OTHER, "us-gaap", "Revenues", "USD", RESTATE_KTS, instant=False)
    assert all(r["value"] in (400.0, 402.0) for r in acme)
    assert [r["value"] for r in other] == [777.0]


# --------------------------------------------------------------------------------------------------- #
# 3. Rename resolves through the stable CIK                                                            #
# --------------------------------------------------------------------------------------------------- #
def test_rename_old_symbol_old_date_and_new_symbol_today_same_cik(lake: Path) -> None:
    """OLDT at an old date and NEWT today both resolve to the SAME CIK — history is continuous across
    the rename (FB@2021 and META@today → CIK 1326801, the canonical case)."""
    s = Store(lake)
    old = s.resolve("OLDT", "US", date(2022, 5, 1))
    new = s.resolve("NEWT", "US", date(2026, 6, 12))
    assert old is not None and new is not None
    assert old["cik"] == new["cik"] == CIK_ACME


def test_resolve_old_symbol_today_falls_back_to_most_recent_era(lake: Path) -> None:
    """Asking for the OLD symbol TODAY (its validity window closed at the rename) falls back to that
    symbol's most recent era rather than dead-ending — like asking for `FB` now."""
    s = Store(lake)
    legacy_today = s.resolve("OLDT", "US", date(2026, 6, 12))
    assert legacy_today is not None
    assert legacy_today["cik"] == CIK_ACME


def test_resolve_is_case_insensitive(lake: Path) -> None:
    """A lower-case symbol resolves the same as upper — the store upper-cases before the lookup."""
    s = Store(lake)
    assert s.resolve("newt", "US", date(2026, 6, 12))["cik"] == CIK_ACME


def test_resolve_enriches_from_entities(lake: Path) -> None:
    """resolve carries the entity name + former_names from entities.parquet when present."""
    s = Store(lake)
    ent = s.resolve("NEWT", "US", date(2026, 6, 12))
    assert ent["name"] == "Acme Corp"
    assert ent["former_names"] == [{"name": "OldCo", "from": "2020-01-01", "to": "2023-06-01"}]


# --------------------------------------------------------------------------------------------------- #
# 4. Graceful degradation (missing CIK / non-US / cold lake)                                           #
# --------------------------------------------------------------------------------------------------- #
def test_missing_cik_file_returns_empty(lake: Path) -> None:
    """A CIK with no per-CIK file → `[]` (an unknown/uncovered name degrades to empty, never crashes)."""
    s = Store(lake)
    assert s.pit_series(424242, "us-gaap", "Revenues", "USD", RESTATE_KTS, instant=False) == []


def test_non_us_market_does_not_resolve(lake: Path) -> None:
    """A non-US (LSE) listing has no EDGAR presence → resolve returns None (the contract layer turns
    this into a fail-closed `{}`)."""
    s = Store(lake)
    assert s.resolve("NEWT", "LSE", date(2026, 6, 12)) is None


def test_unknown_symbol_resolves_none(lake: Path) -> None:
    """A symbol absent from ticker_history → None."""
    s = Store(lake)
    assert s.resolve("ZZZZ", "US", date(2026, 6, 12)) is None


def test_cold_lake_constructs_and_reads_without_crashing(tmp_path: Path) -> None:
    """A cold lake (the directory exists but the harvester has written NOTHING) must construct and
    every read must degrade — no glob view at construction means an empty lake never raises."""
    cold = tmp_path / "cold"
    cold.mkdir()
    s = Store(cold)  # must not raise (the prototype raised here — we deliberately don't)
    assert s.pit_series(CIK_ACME, "us-gaap", "Revenues", "USD", RESTATE_KTS, instant=False) == []
    assert s.resolve("NEWT", "US", date(2026, 6, 12)) is None
    assert s.profile(CIK_ACME) is None
    assert s.facts(CIK_ACME, "us-gaap", "Revenues", "USD", RESTATE_KTS, instant=False) == []


def test_resolve_cold_when_only_facts_present(tmp_path: Path) -> None:
    """facts/ written but ticker_history.parquet absent → resolve degrades to None (can't map a symbol
    to a CIK without the ticker history), while pit_series by CIK still works."""
    root = tmp_path / "partial"
    root.mkdir()
    _write_facts(root, CIK_ACME, [
        _fact(cik=CIK_ACME, concept="Revenues", value=400, start="2023-01-01", end="2023-12-31",
              knowledge_ts=FIRST_PRINT_KTS, accession="A4"),
    ])
    s = Store(root)
    assert s.resolve("NEWT", "US", date(2026, 6, 12)) is None
    assert len(s.pit_series(CIK_ACME, "us-gaap", "Revenues", "USD", FIRST_PRINT_KTS, instant=False)) == 1


# --------------------------------------------------------------------------------------------------- #
# profile + facts (read-API escape hatches)                                                            #
# --------------------------------------------------------------------------------------------------- #
def test_profile_returns_entity_metadata(lake: Path) -> None:
    """profile(cik) decodes the entity row (name, SIC, JSON-list columns) for the /profile route."""
    s = Store(lake)
    p = s.profile(CIK_ACME)
    assert p["cik"] == CIK_ACME
    assert p["name"] == "Acme Corp"
    assert p["sic"] == "7372"
    assert p["sic_description"] == "Prepackaged Software"
    assert p["exchanges"] == ["NYSE"]
    assert p["tickers"] == ["NEWT"]
    assert p["former_names"] == [{"name": "OldCo", "from": "2020-01-01", "to": "2023-06-01"}]


def test_profile_unknown_cik_returns_none(lake: Path) -> None:
    s = Store(lake)
    assert s.profile(424242) is None


def test_facts_is_pit_filtered_raw_passthrough(lake: Path) -> None:
    """facts() is the raw-concept escape hatch — same per-CIK targeting + knowledge_ts cutoff as
    pit_series, no standardization. Before the restatement is knowable it returns the first print."""
    s = Store(lake)
    rows = s.facts(CIK_ACME, "us-gaap", "Revenues", "USD", FIRST_PRINT_KTS, instant=False)
    assert [r["value"] for r in rows] == [400.0]
    later = s.facts(CIK_ACME, "us-gaap", "Revenues", "USD", RESTATE_KTS, instant=False)
    assert [r["value"] for r in later] == [402.0]
