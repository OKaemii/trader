"""Raw-zone writer tests — append-only, hash-gated, idempotent INSERT into fundamentals_raw_facts.

Proves the writer (a) maps a parsed `RawFact` onto the row with the deployed PK contract
(`context_id` NOT NULL DEFAULT '', `period_type` in the key), (b) is idempotent — re-ingesting an
identical fact is an ON CONFLICT no-op, not a duplicate and not an UPDATE, (c) keeps facts that differ
only by `period_type` (instant vs duration sharing a period_end) or by `context_id` as SEPARATE rows
(the full-preservation contract), and (d) stores `knowledge_ts` raw (the filing's accepted_ts — the
UTC→ET availability hop is Task 7). Run against the in-memory `FakeTimescale`, whose `run_execute`
asserts on any UPDATE/DELETE, so an accidental mutation fails the suite (append-only enforced in test,
mirroring the role-level grant).

The end-to-end leg parses a live-shape AAPL companyfacts fixture and writes it through the real writer,
so the "AAPL raw facts land" acceptance bar is proven deterministically without the network."""
from __future__ import annotations

import pytest

from src.download.edgar import RawFact, parse_company_facts
from src.raw_store.content_hash import hash_raw_fact
from src.raw_store.writer import RawFactsWriter, build_raw_fact_row
from tests.fakes import FakeTimescale
from tests.test_edgar_facts import AAPL_FACTS_JSON, _ms


def _fact(**over) -> RawFact:
    base = dict(
        taxonomy="us-gaap", tag="NetIncomeLoss", period_type="duration",
        period_start=_ms("2019-09-29"), period_end=_ms("2020-09-26"), value=57411000000.0,
        unit="USD", currency="USD", accession_number="0000320193-20-000096",
        fiscal_year=2020, fiscal_period="FY", form="10-K", frame="CY2020",
    )
    base.update(over)
    return RawFact(**base)


# ── content hash ──────────────────────────────────────────────────────────────
def test_hash_is_deterministic_and_value_sensitive() -> None:
    kw = dict(filing_id=1, raw_tag="us-gaap:NetIncomeLoss", context_id="", period_type="duration",
              period_start=1, period_end=2, knowledge_ts=3, value=10.0, unit="USD", currency="USD",
              dim_signature="")
    h1 = hash_raw_fact(**kw)
    assert h1 == hash_raw_fact(**kw)                       # stable across calls
    assert h1 != hash_raw_fact(**{**kw, "value": 11.0})    # a value change ⇒ a different digest
    assert h1 != hash_raw_fact(**{**kw, "context_id": "ctx-1"})


def test_hash_treats_none_and_empty_consistently() -> None:
    # A None value and a None currency hash to the '' sentinel (the same the columns use) — but stay
    # distinct from a literal 0.0 / 'USD'.
    kw = dict(filing_id=1, raw_tag="t", context_id="", period_type="instant", period_start=None,
              period_end=2, knowledge_ts=3, value=None, unit=None, currency=None, dim_signature="")
    assert hash_raw_fact(**kw) != hash_raw_fact(**{**kw, "value": 0.0})


# ── row mapping (the PK contract) ─────────────────────────────────────────────
def test_build_row_splits_tag_and_defaults_context() -> None:
    row = build_raw_fact_row(_fact(), filing_id=42, knowledge_ts=1700000000000)
    assert row.raw_tag == "us-gaap:NetIncomeLoss"
    assert row.taxonomy == "us-gaap"
    assert row.context_id == ""            # NEVER None — the NOT NULL DEFAULT '' invariant
    assert row.dim_signature == ""
    assert row.period_type == "duration"
    assert row.knowledge_ts == 1700000000000   # stored raw (accepted_ts), no availability derivation
    assert row.content_hash


def test_build_row_normalises_none_context_to_empty() -> None:
    # A future parser handing context_id=None must still produce '' on the row (defensive — the column
    # is NOT NULL). RawFact's default is already '', so force the None to prove the guard.
    f = _fact()
    object.__setattr__(f, "context_id", None)   # frozen dataclass — simulate a bad upstream value
    row = build_raw_fact_row(f, filing_id=1, knowledge_ts=1)
    assert row.context_id == ""


# ── writer: append-only + idempotency ─────────────────────────────────────────
@pytest.mark.asyncio
async def test_write_facts_inserts_then_idempotent() -> None:
    db = FakeTimescale()
    w = RawFactsWriter(db)
    facts = parse_company_facts(AAPL_FACTS_JSON)
    n1 = await w.write_facts(facts, filing_id=42, knowledge_ts=1700000000000)
    assert n1 == len(facts) and n1 > 0
    assert len(db.raw_facts) == n1
    # Re-ingesting the same filing's facts is a clean no-op (ON CONFLICT DO NOTHING) — 0 new rows.
    n2 = await w.write_facts(facts, filing_id=42, knowledge_ts=1700000000000)
    assert n2 == 0
    assert len(db.raw_facts) == n1


@pytest.mark.asyncio
async def test_write_row_returns_false_on_conflict() -> None:
    db = FakeTimescale()
    w = RawFactsWriter(db)
    row = build_raw_fact_row(_fact(), filing_id=1, knowledge_ts=1)
    assert await w.write_row(row) is True       # fresh
    assert await w.write_row(row) is False      # conflict no-op


@pytest.mark.asyncio
async def test_instant_and_duration_sharing_period_end_are_separate_rows() -> None:
    # The period_type-in-PK fix (dependency card 111): an instant fact and a duration fact that share a
    # period_end must NOT collide. Same filing, same tag, same period_end, different period_type.
    db = FakeTimescale()
    w = RawFactsWriter(db)
    dur = build_raw_fact_row(_fact(period_type="duration", period_start=_ms("2019-09-29")),
                             filing_id=1, knowledge_ts=1)
    inst = build_raw_fact_row(_fact(period_type="instant", period_start=None),
                              filing_id=1, knowledge_ts=1)
    assert await w.write_row(dur) is True
    assert await w.write_row(inst) is True      # NOT a conflict — period_type is in the key
    assert len(db.raw_facts) == 2


@pytest.mark.asyncio
async def test_distinct_contexts_are_separate_rows() -> None:
    # context_id in the PK: two framings of the same tag/period are two preserved rows, not a collision.
    db = FakeTimescale()
    w = RawFactsWriter(db)
    a = build_raw_fact_row(_fact(context_id=""), filing_id=1, knowledge_ts=1)
    b = build_raw_fact_row(_fact(context_id="segment-foo", dim_signature="segment-foo"),
                           filing_id=1, knowledge_ts=1)
    assert await w.write_row(a) is True
    assert await w.write_row(b) is True
    assert len(db.raw_facts) == 2


@pytest.mark.asyncio
async def test_writer_never_issues_update_or_delete() -> None:
    # FakeTimescale.run_execute raises on any UPDATE/DELETE; a clean run proves the raw zone is a pure
    # INSERT log (the secmaster-style append-only grant; the raw role has no UPDATE at all).
    db = FakeTimescale()
    w = RawFactsWriter(db)
    await w.write_facts(parse_company_facts(AAPL_FACTS_JSON), filing_id=7, knowledge_ts=1)
    # No exception ⇒ no UPDATE/DELETE was issued. Re-run to be sure the conflict path is INSERT-only too.
    await w.write_facts(parse_company_facts(AAPL_FACTS_JSON), filing_id=7, knowledge_ts=1)


@pytest.mark.asyncio
async def test_aapl_dei_shares_and_us_gaap_land_with_units() -> None:
    # The acceptance bar: AAPL raw facts present, with the dei share count + us-gaap monetary facts and
    # their units/currency preserved verbatim.
    db = FakeTimescale()
    w = RawFactsWriter(db)
    await w.write_facts(parse_company_facts(AAPL_FACTS_JSON), filing_id=1, knowledge_ts=1)
    shares = next(r for r in db.raw_facts
                  if r["raw_tag"] == "dei:EntityCommonStockSharesOutstanding")
    # Both NetIncomeLoss prints (FY2020 + FY2021) are preserved as separate rows; pick the FY2020 one.
    ni_2020 = next(r for r in db.raw_facts
                   if r["raw_tag"] == "us-gaap:NetIncomeLoss" and r["period_end"] == _ms("2020-09-26"))
    assert shares["unit"] == "shares" and shares["currency"] is None
    assert ni_2020["unit"] == "USD" and ni_2020["currency"] == "USD"
    # Full preservation: the two distinct-period NetIncomeLoss facts are two rows, not one.
    assert sum(1 for r in db.raw_facts if r["raw_tag"] == "us-gaap:NetIncomeLoss") == 2
    # srt:* was not preserved.
    assert not any(r["raw_tag"].startswith("srt:") for r in db.raw_facts)
