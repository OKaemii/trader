"""Ops status aggregation — the data behind the portal Operations PIT-fundamentals panel (card 134).

Aggregates the warehouse + run state into ONE status payload the portal panel reads, so the panel makes
a single call instead of fanning out across coverage / last-run / lag / quarantine / feed-health. The
parts:
  * coverage   — distinct covered instruments + total current facts + oldest observation period, read
                 DIRECTLY off the canonical `fundamentals` table (the same numbers fundamentals-api's
                 `/coverage` returns — we query the warehouse the write-side already owns a pool to,
                 rather than a cross-service HTTP hop that risks a 403→500 the panel would see as a 500).
  * ingestion_lag — `now − newest knowledge_ts` (ms): how stale the freshest fact is. A large lag with a
                 healthy feed means the nightly cron hasn't run / the backfill hasn't landed; the panel
                 turns this into a "fresh / stale" badge. Null when the warehouse is empty (pre-backfill).
  * last_run   — the last force-ingest `RunRecord` (run_id, state, counts, timing) from the run store, or
                 null when no force-ingest has happened this process lifetime (the CronJob runs in a
                 SEPARATE pod, so its runs aren't in this in-process store — documented for card 135).
  * quarantine — the by-reason summary (reuses `qa.report.quarantine_summary`), so the panel shows the QA
                 hold-out queue without a second endpoint.
  * feed_health — the EFFECTIVE config the run will use: the effective UA + its provenance
                 (override/env/default), whether the UA is usable (non-empty), the coverage cap, and the
                 soft ingest-enabled switch. This is the operator's "is my portal UA actually winning,
                 and will a trigger run?" view.

PURE-ish: the SQL reads are thin (`_coverage_row`, `_quarantine`); the assembly (`build_status`) folds
the injected parts so it unit-tests against the FakeTimescale + a fake run store with no network. The
config is resolved by the injected provider (override > env > default).
"""
from __future__ import annotations

import time
from typing import Optional

from src.config import FundamentalsConfig, effective_user_agent
from src.qa.report import quarantine_summary


def _now_ms() -> int:
    return int(time.time() * 1000)


# Coverage over the canonical table — distinct covered instruments, total CURRENT facts, the oldest
# observation period covered, and the freshest knowledge_ts (drives the ingestion-lag badge). Mirrors
# fundamentals-api's `/coverage` query so the two surfaces agree on the numbers.
_COVERAGE_SQL = """
SELECT
    COUNT(DISTINCT instrument_id)   AS instruments,
    COUNT(*)                        AS facts,
    MIN(observation_ts)             AS oldest_observation_ts,
    MAX(knowledge_ts)               AS newest_knowledge_ts
FROM fundamentals
WHERE is_superseded = FALSE
"""


async def _coverage_row(pool) -> dict:
    """Read the coverage/freshness aggregate row off `fundamentals`. Returns zeros/nulls for an empty
    (un-backfilled) warehouse — that is the correct pre-backfill state, not an error."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(_COVERAGE_SQL)
    instruments = int(row["instruments"] or 0) if row else 0
    facts = int(row["facts"] or 0) if row else 0
    oldest = int(row["oldest_observation_ts"]) if row and row["oldest_observation_ts"] is not None else None
    newest = int(row["newest_knowledge_ts"]) if row and row["newest_knowledge_ts"] is not None else None
    return {
        "instruments": instruments,
        "facts": facts,
        "oldest_observation_ts": oldest,
        "newest_knowledge_ts": newest,
    }


def _feed_health(cfg: FundamentalsConfig) -> dict:
    """The effective-config view for the panel: the effective UA + its provenance, whether it is usable
    (the fail-closed signal — an empty UA means a trigger refuses), the coverage cap, and the soft
    ingest-enabled switch. The UA is surfaced as-is (it is non-secret operational config, the value an
    operator sets in the portal), so the panel can show exactly what SEC will receive."""
    ua = effective_user_agent(cfg)
    return {
        "edgar_user_agent": cfg.edgar_user_agent,
        "edgar_user_agent_source": cfg.edgar_user_agent_source,
        "edgar_user_agent_usable": ua is not None,
        "coverage_cap": cfg.coverage_cap,
        "ingest_enabled": cfg.ingest_enabled,
    }


async def build_status(
    pool,
    *,
    config: FundamentalsConfig,
    last_run: Optional[dict],
    quarantine_since_ms: Optional[int] = None,
    quarantine_sample_limit: int = 20,
    now_ms: Optional[int] = None,
) -> dict:
    """Assemble the full status payload. `config` is the already-resolved effective config; `last_run`
    is the run store's latest record payload (or None). Reads coverage + quarantine off `pool`.

    ingestion_lag_ms = now − newest knowledge_ts (None when the warehouse is empty). A negative lag
    (a fact stamped slightly in the future by clock skew) is clamped to 0 — the panel only cares about
    staleness, never a fake "fresh by N ms ahead"."""
    now = now_ms if now_ms is not None else _now_ms()
    coverage = await _coverage_row(pool)
    newest_knowledge_ts = coverage["newest_knowledge_ts"]
    ingestion_lag_ms = max(0, now - newest_knowledge_ts) if newest_knowledge_ts is not None else None

    quarantine = await quarantine_summary(
        pool, since_ms=quarantine_since_ms, sample_limit=quarantine_sample_limit
    )

    return {
        "coverage": {
            "instruments": coverage["instruments"],
            "facts": coverage["facts"],
            "oldest_observation_ts": coverage["oldest_observation_ts"],
            "newest_knowledge_ts": newest_knowledge_ts,
        },
        "ingestion_lag_ms": ingestion_lag_ms,
        "last_run": last_run,
        "quarantine": {
            "total": quarantine.get("total", 0),
            "by_reason": quarantine.get("by_reason", {}),
            "by_sector": quarantine.get("by_sector", {}),
            "recent": quarantine.get("recent", []),
        },
        "feed_health": _feed_health(config),
        "generated_at_ms": now,
    }
