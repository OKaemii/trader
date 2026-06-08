"""Bi-temporal `fundamentals` writer tests — the PIT-contract core (epic Task 7).

Proves the supersede-in-transaction writer (mirroring persist-bars.ts):
  * first-print → a single is_superseded=FALSE row + a revisions-log row with prior_hash NULL;
  * a 10-K/A restatement → a NEW row (higher knowledge_ts) + the prior row flipped is_superseded=TRUE,
    in ONE transaction; the original row is NEVER overwritten, so an as-of read at the original date
    still returns the first-printed value;
  * an identical re-ingest is a NO-OP (no insert, no supersede, no log row);
  * `knowledge_ts` is the DERIVED availability (next NYSE session open after accepted_ts), not the raw
    accept (after-hours acceptance → next session);
  * value-agreement conflicts from staging are handed off to fundamentals_quarantine cleanly;
  * a missing instrument_id raises (never a fabricated id);
  * the canonical content_hash is value-sensitive but ignores provenance (a corrected accession/raw_tag
    with the same value is a no-op).

Run against the in-memory FakeTimescale (whose run_execute permits ONLY the UPDATE(is_superseded)
supersede + the append-only log/quarantine inserts, asserting on any other mutation — the append-only
role grant, enforced in test). No network, no DB.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from src.normalize.content_hash import hash_fundamental
from src.normalize.writer import (
    SOURCE_PIT_EDGAR,
    FundamentalsWriter,
    build_fundamental_row,
)
from src.stage.resolver import InterpretedFact, StageResult, ValueConflict
from tests.fakes import FakeTimescale


def _ms(dt_str: str) -> int:
    """'YYYY-MM-DD HH:MM' UTC → epoch ms."""
    return int(
        datetime.strptime(dt_str, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp() * 1000
    )


def _fact(**over) -> InterpretedFact:
    """A consolidated net_income InterpretedFact for FY2020 (AAPL CIK), the staging output shape. knowledge_ts
    stays None on the staged fact — the writer derives it from the filing's accepted_ts."""
    base = dict(
        metric="net_income",
        cik="0000320193",
        value=57411000000.0,
        unit="USD",
        currency="USD",
        period_start=_ms("2019-09-29 00:00"),
        period_end=_ms("2020-09-26 00:00"),
        period_type="duration",
        fiscal_year=2020,
        fiscal_period="FY",
        dim_signature="",
        is_segment=False,
        raw_tag="us-gaap:NetIncomeLoss",
        accession_number="0000320193-20-000096",
        knowledge_ts=None,
    )
    base.update(over)
    return InterpretedFact(**base)


def _result(*facts: InterpretedFact, conflicts: tuple[ValueConflict, ...] = ()) -> StageResult:
    return StageResult(facts=tuple(facts), conflicts=conflicts)


# An accept timestamp + its derived next-session open (validated in test_normalize_calendar). The 10-K
# for FY2020 was accepted after-hours on a Friday; the writer must derive the NEXT session open.
_ACCEPTED_ORIG = _ms("2020-10-30 22:00")          # Fri after-hours (genuine UTC accepted_ts)
_ACCEPTED_RESTATE = _ms("2021-01-15 22:00")       # a later 10-K/A re-reports FY2020


# ── first-print ─────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_first_print_writes_one_current_row_with_null_prior_hash() -> None:
    db = FakeTimescale()
    writer = FundamentalsWriter(db)
    stats = await writer.write_filing(_result(_fact()), instrument_id=7, accepted_ts_ms=_ACCEPTED_ORIG)

    assert stats.inserted == 1 and stats.revisions == 0 and stats.skipped == 0
    assert len(db.fundamentals) == 1
    row = db.fundamentals[0]
    assert row["instrument_id"] == 7 and row["metric"] == "net_income"
    assert row["is_superseded"] is False
    assert row["source"] == SOURCE_PIT_EDGAR
    # observation_ts is the fiscal period_end.
    assert row["observation_ts"] == _ms("2020-09-26 00:00")
    # knowledge_ts is DERIVED (the next session open), NOT the raw accept.
    assert row["knowledge_ts"] != _ACCEPTED_ORIG
    assert row["knowledge_ts"] > _ACCEPTED_ORIG       # next session is after the after-hours accept
    # the revisions log records the first-print: prior_hash NULL, new_hash = the row's hash.
    assert len(db.fundamentals_revisions_log) == 1
    log = db.fundamentals_revisions_log[0]
    assert log["prior_hash"] is None
    assert log["new_hash"] == row["content_hash"]
    assert log["accession_number"] == "0000320193-20-000096"


# ── idempotent re-ingest ────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_identical_reingest_is_a_noop() -> None:
    db = FakeTimescale()
    writer = FundamentalsWriter(db)
    await writer.write_filing(_result(_fact()), instrument_id=7, accepted_ts_ms=_ACCEPTED_ORIG)
    # Re-run the SAME staged fact + same filing — identical content hash AND identical derived
    # knowledge_ts → a clean no-op (no second row, no supersede, no second log row).
    stats = await writer.write_filing(_result(_fact()), instrument_id=7, accepted_ts_ms=_ACCEPTED_ORIG)

    assert stats.inserted == 0 and stats.skipped == 1 and stats.revisions == 0
    assert len(db.fundamentals) == 1
    assert len(db.fundamentals_revisions_log) == 1     # still just the first-print log row


# ── restatement (10-K/A) ────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_restatement_supersedes_and_keeps_the_original() -> None:
    db = FakeTimescale()
    writer = FundamentalsWriter(db)
    # First print: FY2020 net income.
    await writer.write_filing(_result(_fact()), instrument_id=7, accepted_ts_ms=_ACCEPTED_ORIG)
    original_hash = db.fundamentals[0]["content_hash"]
    original_knowledge = db.fundamentals[0]["knowledge_ts"]

    # A 10-K/A re-reports FY2020 with a RESTATED value, accepted later → a new row + supersede.
    restated = _fact(value=57000000000.0, accession_number="0000320193-21-000010")
    stats = await writer.write_filing(
        _result(restated), instrument_id=7, accepted_ts_ms=_ACCEPTED_RESTATE
    )

    assert stats.inserted == 1 and stats.revisions == 1 and stats.skipped == 0
    # TWO rows now (the original preserved + the restated), exactly ONE current.
    assert len(db.fundamentals) == 2
    current = [r for r in db.fundamentals if not r["is_superseded"]]
    superseded = [r for r in db.fundamentals if r["is_superseded"]]
    assert len(current) == 1 and len(superseded) == 1
    # The ORIGINAL row is the superseded one — never overwritten (its value + hash + knowledge_ts intact).
    assert superseded[0]["content_hash"] == original_hash
    assert superseded[0]["value"] == 57411000000.0
    assert superseded[0]["knowledge_ts"] == original_knowledge
    # The CURRENT row is the restated value, with a LATER (derived) knowledge_ts.
    assert current[0]["value"] == 57000000000.0
    assert current[0]["knowledge_ts"] > original_knowledge
    # The revisions log has BOTH: the first-print (prior_hash NULL) and the restatement (prior_hash =
    # the original hash).
    assert len(db.fundamentals_revisions_log) == 2
    restate_log = [l for l in db.fundamentals_revisions_log if l["prior_hash"] is not None]
    assert len(restate_log) == 1
    assert restate_log[0]["prior_hash"] == original_hash
    assert restate_log[0]["new_hash"] == current[0]["content_hash"]
    assert restate_log[0]["accession_number"] == "0000320193-21-000010"


@pytest.mark.asyncio
async def test_as_of_read_at_original_date_returns_first_print_value() -> None:
    # The bi-temporal guarantee: after a restatement, an AS-OF read at the original knowledge-time must
    # still return the first-printed value (no look-ahead to the restatement). Reproduce the as-of read
    # the Task-11 api will run: latest row with knowledge_ts <= as_of.
    db = FakeTimescale()
    writer = FundamentalsWriter(db)
    await writer.write_filing(_result(_fact()), instrument_id=7, accepted_ts_ms=_ACCEPTED_ORIG)
    original_knowledge = db.fundamentals[0]["knowledge_ts"]
    restated = _fact(value=57000000000.0, accession_number="0000320193-21-000010")
    await writer.write_filing(_result(restated), instrument_id=7, accepted_ts_ms=_ACCEPTED_RESTATE)

    def as_of_value(as_of_ms: int):
        candidates = [
            r for r in db.fundamentals
            if r["instrument_id"] == 7 and r["metric"] == "net_income"
            and r["observation_ts"] == _ms("2020-09-26 00:00") and r["dim_signature"] == ""
            and r["knowledge_ts"] <= as_of_ms
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda r: r["knowledge_ts"])["value"]

    # At the original knowledge-time: only the first-print is known → the originally-reported value.
    assert as_of_value(original_knowledge) == 57411000000.0
    # Just BEFORE the restatement landed: still the first print.
    restated_knowledge = max(r["knowledge_ts"] for r in db.fundamentals)
    assert as_of_value(restated_knowledge - 1) == 57411000000.0
    # At/after the restatement: the restated value.
    assert as_of_value(restated_knowledge) == 57000000000.0


@pytest.mark.asyncio
async def test_value_unchanged_but_provenance_changed_is_a_noop() -> None:
    # A re-derivation that changes ONLY provenance (accession/raw_tag) with the SAME value must NOT
    # supersede — the canonical hash ignores provenance. (A corrected accession is not a value revision.)
    db = FakeTimescale()
    writer = FundamentalsWriter(db)
    await writer.write_filing(_result(_fact()), instrument_id=7, accepted_ts_ms=_ACCEPTED_ORIG)
    # Same value/unit/currency/metric/period/dim; different accession + a synonymous tag.
    reprovenanced = _fact(accession_number="9999999999-99-999999", raw_tag="us-gaap:ProfitLoss")
    stats = await writer.write_filing(
        _result(reprovenanced), instrument_id=7, accepted_ts_ms=_ACCEPTED_ORIG
    )
    assert stats.skipped == 1 and stats.inserted == 0
    assert len(db.fundamentals) == 1


# ── multiple metrics + segment isolation ────────────────────────────────────────
@pytest.mark.asyncio
async def test_multiple_metrics_and_segment_rows_are_independent() -> None:
    db = FakeTimescale()
    writer = FundamentalsWriter(db)
    consolidated = _fact(metric="total_revenue", value=274515000000.0, raw_tag="us-gaap:Revenues")
    equity = _fact(
        metric="total_equity", value=65339000000.0, period_type="instant", period_start=None,
        raw_tag="us-gaap:StockholdersEquity",
    )
    # A segment fact shares the metric+period but a non-empty dim_signature → a DIFFERENT logical fact
    # (its own current row), never merged into the consolidated total.
    segment = _fact(
        metric="total_revenue", value=100000000000.0, dim_signature="ProductOrServiceAxis=Product",
        is_segment=True, raw_tag="us-gaap:Revenues",
    )
    stats = await writer.write_filing(
        _result(consolidated, equity, segment), instrument_id=7, accepted_ts_ms=_ACCEPTED_ORIG
    )
    assert stats.inserted == 3
    # Three independent current rows.
    assert len([r for r in db.fundamentals if not r["is_superseded"]]) == 3
    revenue_rows = [r for r in db.fundamentals if r["metric"] == "total_revenue"]
    assert {r["dim_signature"] for r in revenue_rows} == {"", "ProductOrServiceAxis=Product"}


# ── conflicts → quarantine handoff ──────────────────────────────────────────────
@pytest.mark.asyncio
async def test_value_conflicts_are_routed_to_quarantine() -> None:
    db = FakeTimescale()
    writer = FundamentalsWriter(db)
    conflict = ValueConflict(
        metric="total_revenue", cik="0000320193",
        period_start=_ms("2019-09-29 00:00"), period_end=_ms("2020-09-26 00:00"), dim_signature="",
        tag_a="us-gaap:Revenues", value_a=274515000000.0,
        tag_b="us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", value_b=265595000000.0,
    )
    stats = await writer.write_filing(
        _result(_fact(), conflicts=(conflict,)),
        instrument_id=7, accepted_ts_ms=_ACCEPTED_ORIG, filing_id=42,
    )
    # The clean fact is written; the conflict is handed off (not dropped, not blocking the write).
    assert stats.inserted == 1 and stats.quarantined == 1
    assert len(db.fundamentals_quarantine) == 1
    q = db.fundamentals_quarantine[0]
    assert q["instrument_id"] == 7 and q["filing_id"] == 42
    assert q["reason"] == "value_disagreement"
    # payload is JSON carrying both disagreeing tags for the Task-8 review surface.
    import json
    payload = json.loads(q["payload"])
    assert payload["metric"] == "total_revenue"
    assert payload["tag_a"] == "us-gaap:Revenues"
    assert payload["value_b"] == 265595000000.0


@pytest.mark.asyncio
async def test_no_conflicts_writes_no_quarantine_rows() -> None:
    db = FakeTimescale()
    writer = FundamentalsWriter(db)
    stats = await writer.write_filing(_result(_fact()), instrument_id=7, accepted_ts_ms=_ACCEPTED_ORIG)
    assert stats.quarantined == 0
    assert db.fundamentals_quarantine == []


# ── guards ──────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_missing_instrument_id_raises() -> None:
    db = FakeTimescale()
    writer = FundamentalsWriter(db)
    with pytest.raises(ValueError):
        await writer.write_filing(_result(_fact()), instrument_id=None, accepted_ts_ms=_ACCEPTED_ORIG)


@pytest.mark.asyncio
async def test_empty_result_writes_nothing() -> None:
    db = FakeTimescale()
    writer = FundamentalsWriter(db)
    stats = await writer.write_filing(_result(), instrument_id=7, accepted_ts_ms=_ACCEPTED_ORIG)
    assert stats.attempted == 0 and stats.inserted == 0
    assert db.fundamentals == [] and db.fundamentals_revisions_log == []


# ── canonical content hash ──────────────────────────────────────────────────────
def test_content_hash_is_value_sensitive_and_provenance_blind() -> None:
    kw = dict(metric="net_income", observation_ts=_ms("2020-09-26 00:00"), value=57411000000.0,
              unit="USD", currency="USD", dim_signature="")
    h = hash_fundamental(**kw)
    assert h == hash_fundamental(**kw)                          # deterministic
    assert h != hash_fundamental(**{**kw, "value": 57000000000.0})   # value change supersedes
    assert h != hash_fundamental(**{**kw, "unit": "USD/shares"})     # unit change supersedes
    assert h != hash_fundamental(**{**kw, "currency": "EUR"})        # currency change supersedes
    assert h != hash_fundamental(**{**kw, "dim_signature": "Axis=X"})  # segment vs consolidated differ


def test_build_row_hash_matches_standalone_hash() -> None:
    # The row builder's content_hash must equal the standalone hash over the same tuple (the gate reads
    # the stored hash; a divergence would make every fact look like a revision).
    row = build_fundamental_row(_fact(), instrument_id=7, knowledge_ts=123)
    assert row.content_hash == hash_fundamental(
        metric="net_income", observation_ts=_ms("2020-09-26 00:00"), value=57411000000.0,
        unit="USD", currency="USD", dim_signature="",
    )
    # knowledge_ts + instrument_id + provenance are NOT in the hash.
    other = build_fundamental_row(
        _fact(accession_number="X", raw_tag="us-gaap:ProfitLoss"), instrument_id=99, knowledge_ts=999
    )
    assert other.content_hash == row.content_hash
