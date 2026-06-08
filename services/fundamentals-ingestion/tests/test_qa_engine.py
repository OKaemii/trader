"""QA engine + report tests at the DB seam — quarantine writes + the admin summary (epic Task 8).

Proves the engine routes findings to `fundamentals_quarantine` (alongside the canonical write, never
blocking it), fetches the outlier baseline from the warehouse, raises on a missing instrument_id
(mirroring the writer), and that `report.quarantine_summary` aggregates the queue by reason + sector.
Run against the in-memory FakeTimescale (the same fake the writer tests use) — no network, no DB.
"""
from __future__ import annotations

import json

import pytest

from src.qa.checks import REASON_IDENTITY_BREAK, REASON_MISSING_DATA, REASON_OUTLIER
from src.qa.engine import QaEngine
from src.qa.report import SECTOR_UNKNOWN, quarantine_summary
from src.stage.resolver import InterpretedFact, StageResult
from tests.fakes import FakeTimescale

_PERIOD_END = 1_600_000_000_000
_PRIOR_PERIOD_END = _PERIOD_END - 365 * 86_400_000


def _instant(metric: str, value, *, dim: str = "", period_end: int = _PERIOD_END) -> InterpretedFact:
    return InterpretedFact(
        metric=metric, cik="0000000000", value=value, unit="USD", currency="USD",
        period_start=None, period_end=period_end, period_type="instant",
        fiscal_year=2020, fiscal_period="FY", dim_signature=dim, is_segment=bool(dim),
        raw_tag=f"us-gaap:{metric}", accession_number="acc-1", knowledge_ts=None,
    )


def _duration(metric: str, value, *, period_end: int = _PERIOD_END) -> InterpretedFact:
    return InterpretedFact(
        metric=metric, cik="0000000000", value=value, unit="USD", currency="USD",
        period_start=period_end - 365 * 86_400_000, period_end=period_end, period_type="duration",
        fiscal_year=2020, fiscal_period="FY", dim_signature="", is_segment=False,
        raw_tag=f"us-gaap:{metric}", accession_number="acc-1", knowledge_ts=None,
    )


def _seed_current_fact(db: FakeTimescale, *, instrument_id: int, metric: str, value: float,
                       observation_ts: int, dim: str = "") -> None:
    """Insert a CURRENT (is_superseded=FALSE) canonical row directly — the prior-period baseline the
    outlier check reads. (Bypasses the writer; we only need the row present for the SELECT.)"""
    db.fundamentals.append({
        "instrument_id": instrument_id, "metric": metric, "observation_ts": observation_ts,
        "knowledge_ts": observation_ts + 1, "fiscal_year": 2019, "fiscal_period": "FY",
        "period_type": "instant", "dim_signature": dim, "value": value, "unit": "USD",
        "currency": "USD", "source": "pit-edgar", "accession_number": "acc-0", "raw_tag": "x",
        "content_hash": "h", "is_superseded": False,
    })


def _full_clean_filing() -> list[InterpretedFact]:
    """A complete, balancing, all-required-present General filing (no findings expected)."""
    return [
        _instant("total_assets", 1_000.0),
        _instant("total_liabilities", 600.0),
        _instant("total_equity", 400.0),
        _duration("total_revenue", 800.0),
        _duration("net_income", 100.0),
        _instant("shares_outstanding", 1_000_000.0),
    ]


# ── engine: quarantine writes ─────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_identity_break_is_quarantined_under_general() -> None:
    db = FakeTimescale()
    engine = QaEngine(db)
    facts = [
        _instant("total_assets", 1_000.0),
        _instant("total_liabilities", 50.0),   # 50 + 400 ≠ 1000 → break
        _instant("total_equity", 400.0),
        _duration("total_revenue", 800.0),
        _duration("net_income", 100.0),
        _instant("shares_outstanding", 1_000_000.0),
    ]
    stats = await engine.qa_filing(
        StageResult(facts=tuple(facts), conflicts=()),
        instrument_id=7, sector="general", filing_id=42,
    )
    assert stats.quarantined == 1
    assert stats.by_reason == {REASON_IDENTITY_BREAK: 1}
    assert len(db.fundamentals_quarantine) == 1
    row = db.fundamentals_quarantine[0]
    assert row["instrument_id"] == 7 and row["filing_id"] == 42
    assert row["reason"] == REASON_IDENTITY_BREAK
    payload = json.loads(row["payload"])
    assert payload["check"] == "balance_sheet_identity"
    assert payload["metric"] == "total_assets"
    assert payload["observation_ts"] == _PERIOD_END


@pytest.mark.asyncio
async def test_same_break_under_bank_is_not_quarantined() -> None:
    # THE acceptance criterion: identical non-balancing numbers, BANK template → no identity quarantine.
    db = FakeTimescale()
    engine = QaEngine(db)
    facts = [
        _instant("total_assets", 1_000.0),
        _instant("total_liabilities", 50.0),
        _instant("total_equity", 400.0),
        _duration("total_revenue", 800.0),
        _duration("net_income", 100.0),
        _instant("shares_outstanding", 1_000_000.0),
    ]
    stats = await engine.qa_filing(
        StageResult(facts=tuple(facts), conflicts=()),
        instrument_id=7, sector="bank",
    )
    assert stats.quarantined == 0
    assert all(r["reason"] != REASON_IDENTITY_BREAK for r in db.fundamentals_quarantine)


@pytest.mark.asyncio
async def test_outlier_uses_warehouse_prior_value() -> None:
    db = FakeTimescale()
    # Prior-period revenue = 100 at an earlier observation; this filing reports 5100 (51x) → spike. The
    # engine reads that baseline from the warehouse (not handed in), proving the prior-value SELECT.
    _seed_current_fact(db, instrument_id=7, metric="total_revenue", value=100.0,
                       observation_ts=_PRIOR_PERIOD_END)
    facts = [f for f in _full_clean_filing() if f.metric != "total_revenue"]
    facts.append(_duration("total_revenue", 5_100.0))
    stats = await QaEngine(db).qa_filing(facts, instrument_id=7, sector="general")
    assert stats.by_reason.get(REASON_OUTLIER) == 1
    outlier = next(r for r in db.fundamentals_quarantine if r["reason"] == REASON_OUTLIER)
    payload = json.loads(outlier["payload"])
    assert payload["metric"] == "total_revenue"
    assert payload["current"] == 5_100.0 and payload["prior"] == 100.0


@pytest.mark.asyncio
async def test_missing_shares_is_quarantined() -> None:
    db = FakeTimescale()
    engine = QaEngine(db)
    facts = [f for f in _full_clean_filing() if f.metric != "shares_outstanding"]
    stats = await engine.qa_filing(facts, instrument_id=7, sector="general")
    assert stats.by_reason.get(REASON_MISSING_DATA) == 1
    missing = next(r for r in db.fundamentals_quarantine if r["reason"] == REASON_MISSING_DATA)
    assert json.loads(missing["payload"])["metric"] == "shares_outstanding"


@pytest.mark.asyncio
async def test_clean_filing_quarantines_nothing() -> None:
    db = FakeTimescale()
    # Seed a sane prior so the outlier check has a baseline and still passes (no spike).
    _seed_current_fact(db, instrument_id=7, metric="total_revenue", value=750.0,
                       observation_ts=_PRIOR_PERIOD_END)
    _seed_current_fact(db, instrument_id=7, metric="total_assets", value=950.0,
                       observation_ts=_PRIOR_PERIOD_END)
    stats = await QaEngine(db).qa_filing(_full_clean_filing(), instrument_id=7, sector="general")
    assert stats.quarantined == 0
    assert db.fundamentals_quarantine == []


@pytest.mark.asyncio
async def test_first_ever_filing_has_no_outlier_baseline() -> None:
    # No prior rows in the warehouse → no outlier baseline → a wildly large first observation is not an
    # outlier (it's the first one). Only the missing/identity families can fire.
    db = FakeTimescale()
    stats = await QaEngine(db).qa_filing(_full_clean_filing(), instrument_id=7, sector="general")
    assert stats.by_reason.get(REASON_OUTLIER) is None
    assert stats.quarantined == 0


@pytest.mark.asyncio
async def test_missing_instrument_id_raises() -> None:
    db = FakeTimescale()
    with pytest.raises(ValueError):
        await QaEngine(db).qa_filing(_full_clean_filing(), instrument_id=None, sector="general")


@pytest.mark.asyncio
async def test_stage_result_and_bare_iterable_are_equivalent() -> None:
    facts = [f for f in _full_clean_filing() if f.metric != "shares_outstanding"]
    db_a = FakeTimescale()
    db_b = FakeTimescale()
    stats_a = await QaEngine(db_a).qa_filing(facts, instrument_id=7, sector="general")
    stats_b = await QaEngine(db_b).qa_filing(
        StageResult(facts=tuple(facts), conflicts=()), instrument_id=7, sector="general"
    )
    assert stats_a.by_reason == stats_b.by_reason


# ── report: quarantine summary aggregation ────────────────────────────────────────
def _seed_company(db: FakeTimescale, *, instrument_id: int, company_id: int, sector: str) -> None:
    db.companies.append({
        "company_id": company_id, "name": f"co-{company_id}", "country": "US",
        "sector": sector, "industry": "x", "cik": str(company_id), "lei": None,
    })
    db.instruments.append({
        "instrument_id": instrument_id, "company_id": company_id, "instrument_type": "common",
        "exchange": "NASDAQ", "currency": "USD", "t212_ticker": f"T{instrument_id}_US_EQ",
    })


@pytest.mark.asyncio
async def test_report_counts_by_reason_and_sector() -> None:
    db = FakeTimescale()
    # A financial (bank) instrument and an industrial (general) instrument, with quarantine rows each.
    _seed_company(db, instrument_id=1, company_id=11, sector="Financials")
    _seed_company(db, instrument_id=2, company_id=22, sector="Industrials")

    # instrument 1: two outliers; instrument 2: one missing-data; an unresolved-instrument row.
    for reason, inst, payload in [
        (REASON_OUTLIER, 1, {"check": "period_ratio"}),
        (REASON_OUTLIER, 1, {"check": "sign_flip"}),
        (REASON_MISSING_DATA, 2, {"check": "missing_required_metric"}),
        (REASON_IDENTITY_BREAK, None, {"check": "balance_sheet_identity"}),  # pre-resolution failure
    ]:
        db.fundamentals_quarantine.append({
            "event_id": db._next("quarantine"), "occurred_at": db._seq["quarantine"],
            "instrument_id": inst, "filing_id": None, "reason": reason,
            "payload": json.dumps(payload),
        })

    summary = await quarantine_summary(db, since_ms=None, sample_limit=10)
    assert summary["total"] == 4
    assert summary["by_reason"] == {REASON_OUTLIER: 2, REASON_IDENTITY_BREAK: 1, REASON_MISSING_DATA: 1}
    # Financials has 2 (instrument 1), Industrials 1 (instrument 2), the unresolved row → (unknown).
    assert summary["by_sector"]["Financials"] == 2
    assert summary["by_sector"]["Industrials"] == 1
    assert summary["by_sector"][SECTOR_UNKNOWN] == 1
    # The recent sample carries decoded payloads (dict, not a JSON string).
    assert len(summary["recent"]) == 4
    assert isinstance(summary["recent"][0]["payload"], dict)
    # Newest-first ordering (the last-inserted event_id leads).
    assert summary["recent"][0]["event_id"] == 4


@pytest.mark.asyncio
async def test_report_empty_queue() -> None:
    db = FakeTimescale()
    summary = await quarantine_summary(db, since_ms=None)
    assert summary["total"] == 0
    assert summary["by_reason"] == {} and summary["by_sector"] == {} and summary["recent"] == []


@pytest.mark.asyncio
async def test_report_end_to_end_from_engine_writes() -> None:
    # An end-to-end slice: the engine quarantines a financial's identity-free filing (bank, no break) and
    # an industrial's broken filing — the report reflects exactly what the engine wrote.
    db = FakeTimescale()
    _seed_company(db, instrument_id=1, company_id=11, sector="Industrials")
    broken = [
        _instant("total_assets", 1_000.0), _instant("total_liabilities", 50.0),
        _instant("total_equity", 400.0), _duration("total_revenue", 800.0),
        _duration("net_income", 100.0), _instant("shares_outstanding", 1_000_000.0),
    ]
    await QaEngine(db).qa_filing(broken, instrument_id=1, sector="general")
    summary = await quarantine_summary(db, since_ms=None)
    assert summary["by_reason"].get(REASON_IDENTITY_BREAK) == 1
    assert summary["by_sector"].get("Industrials") == 1
