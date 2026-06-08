"""Ops status aggregation tests — the portal Operations PIT-fundamentals panel payload (Ops backend card).

Proves `build_status` folds the five parts (coverage, ingestion lag, last_run, quarantine, feed_health)
off the FakeTimescale + an injected effective config + a last-run dict — no network, no real DB. The
coverage/lag SQL needs the fake to answer the `SELECT COUNT(DISTINCT instrument_id)…MAX(knowledge_ts)`
aggregate, which the shared FakeTimescale doesn't model, so this suite extends it with a thin coverage
answer (the same in-memory rows the canonical writer would have produced).
"""
from __future__ import annotations

import json

import pytest

from src.config import FundamentalsConfig
from src.qa.checks import REASON_OUTLIER
from src.status import build_status
from tests.fakes import FakeTimescale


class _CoverageFakeTimescale(FakeTimescale):
    """FakeTimescale + the status coverage aggregate (`_COVERAGE_SQL`). The base fake doesn't recognise
    the COUNT(DISTINCT)…MAX(knowledge_ts) shape the status module issues, so answer it here off the
    in-memory current `fundamentals` rows — keeping the test a faithful in-memory store, not a SQL
    engine."""

    def run_fetch(self, query, args):
        q = self._norm(query)
        if "count(distinct instrument_id)" in q and "from fundamentals" in q and "max(knowledge_ts)" in q:
            current = [r for r in self.fundamentals if not r["is_superseded"]]
            instruments = {r["instrument_id"] for r in current}
            obs = [r["observation_ts"] for r in current]
            know = [r["knowledge_ts"] for r in current]
            return [{
                "instruments": len(instruments),
                "facts": len(current),
                "oldest_observation_ts": min(obs) if obs else None,
                "newest_knowledge_ts": max(know) if know else None,
            }]
        return super().run_fetch(query, args)


def _cfg(ua="trader-platform/1.0 (ops@example.com)", *, source="override", cap=64, enabled=True):
    return FundamentalsConfig(
        edgar_user_agent=ua, coverage_cap=cap, ingest_enabled=enabled, edgar_user_agent_source=source
    )


def _seed_fact(db, *, instrument_id, metric, observation_ts, knowledge_ts):
    db.fundamentals.append({
        "instrument_id": instrument_id, "metric": metric, "observation_ts": observation_ts,
        "knowledge_ts": knowledge_ts, "dim_signature": "", "value": 1.0, "is_superseded": False,
        "content_hash": "h", "source": "pit-edgar",
    })


@pytest.mark.asyncio
async def test_build_status_aggregates_all_parts() -> None:
    db = _CoverageFakeTimescale()
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=1_000, knowledge_ts=5_000)
    _seed_fact(db, instrument_id=1, metric="total_equity", observation_ts=1_000, knowledge_ts=6_000)
    _seed_fact(db, instrument_id=2, metric="net_income", observation_ts=2_000, knowledge_ts=7_000)
    db.fundamentals_quarantine.append({
        "event_id": db._next("quarantine"), "occurred_at": db._seq["quarantine"],
        "instrument_id": None, "filing_id": None, "reason": REASON_OUTLIER,
        "payload": json.dumps({"check": "period_ratio"}),
    })

    last_run = {"run_id": "abc", "state": "done", "canonical_inserted": 12}
    status = await build_status(
        db, config=_cfg(), last_run=last_run, now_ms=10_000,
    )

    # Coverage: 2 distinct instruments, 3 current facts, oldest observation 1000, newest knowledge 7000.
    assert status["coverage"]["instruments"] == 2
    assert status["coverage"]["facts"] == 3
    assert status["coverage"]["oldest_observation_ts"] == 1_000
    assert status["coverage"]["newest_knowledge_ts"] == 7_000

    # Ingestion lag = now (10000) − newest knowledge (7000) = 3000ms.
    assert status["ingestion_lag_ms"] == 3_000

    # Last run passed through verbatim.
    assert status["last_run"] == last_run

    # Quarantine summary folded in.
    assert status["quarantine"]["total"] == 1
    assert status["quarantine"]["by_reason"] == {REASON_OUTLIER: 1}

    # Feed health surfaces the effective config + the usable/provenance signals.
    fh = status["feed_health"]
    assert fh["edgar_user_agent"] == "trader-platform/1.0 (ops@example.com)"
    assert fh["edgar_user_agent_source"] == "override"
    assert fh["edgar_user_agent_usable"] is True
    assert fh["coverage_cap"] == 64
    assert fh["ingest_enabled"] is True


@pytest.mark.asyncio
async def test_build_status_empty_warehouse_is_zeros_and_null_lag() -> None:
    db = _CoverageFakeTimescale()
    status = await build_status(db, config=_cfg(), last_run=None, now_ms=10_000)
    assert status["coverage"]["instruments"] == 0
    assert status["coverage"]["facts"] == 0
    assert status["coverage"]["newest_knowledge_ts"] is None
    assert status["ingestion_lag_ms"] is None  # no facts ⇒ no lag (not a fake 'fresh')
    assert status["last_run"] is None
    assert status["quarantine"]["total"] == 0


@pytest.mark.asyncio
async def test_feed_health_flags_empty_ua_unusable() -> None:
    db = _CoverageFakeTimescale()
    status = await build_status(db, config=_cfg(ua="", source="default"), last_run=None, now_ms=1)
    fh = status["feed_health"]
    assert fh["edgar_user_agent"] == ""
    assert fh["edgar_user_agent_usable"] is False  # the fail-closed signal the panel surfaces


@pytest.mark.asyncio
async def test_ingestion_lag_clamps_future_knowledge_ts_to_zero() -> None:
    db = _CoverageFakeTimescale()
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=1, knowledge_ts=20_000)
    status = await build_status(db, config=_cfg(), last_run=None, now_ms=10_000)
    # newest knowledge (20000) is AHEAD of now (10000) by clock skew → lag clamps to 0, never negative.
    assert status["ingestion_lag_ms"] == 0
