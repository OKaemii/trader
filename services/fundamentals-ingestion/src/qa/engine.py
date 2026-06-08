"""QA engine — run the pure checks over a filing + route failures to `fundamentals_quarantine`
(epic Task 8).

This is the DB-seam wrapper around the pure `qa/checks.py`. It:
  1. fetches the prior-period value of each consolidated metric from the warehouse (the only input the
     outlier check needs that isn't on the filing itself);
  2. runs `checks.run_checks(...)`;
  3. appends each `QuarantineFinding` to `fundamentals_quarantine` as a `(reason, payload)` row, with
     the engine's `instrument_id`/`filing_id` riding in for provenance.

It mirrors the Task-7 writer's quarantine handoff exactly (same table, same thin INSERT, same
best-effort isolation) — the writer already routes `value_disagreement` conflicts; this engine adds the
`identity_break` / `outlier` / `missing_data` reasons over the SAME normalized facts. It runs ALONGSIDE
the canonical write (the writer persisted the good rows; QA quarantines the suspect ones for review) and
NEVER blocks: a quarantine-insert failure logs and continues, and the engine does not delete or mutate
any canonical row (it only appends to the review queue). The append-only `fundamentals_writer` role
(0009: INSERT+SELECT on quarantine + its sequence) covers exactly these writes.

Like the writer, it takes an injected `asyncpg.Pool` (security_master/pool.py owns construction), holds
no global state, and opens no socket on import. The pure checks stay importable without a pool.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Iterable, Optional

from src.stage.resolver import InterpretedFact, StageResult

from . import checks
from .checks import QuarantineFinding

log = logging.getLogger("fundamentals-ingestion.qa")


@dataclass(frozen=True)
class QaStats:
    """The outcome of QA'ing one filing (mirrors the writer's `WriteStats` shape).

      * `checked`     — consolidated facts considered.
      * `quarantined` — findings appended to `fundamentals_quarantine`.
      * `by_reason`   — quarantined count broken down by reason (for logs / the trigger response).
    """

    checked: int
    quarantined: int
    by_reason: dict[str, int]


# ── SQL ────────────────────────────────────────────────────────────────────────────
# Prior-period value of a consolidated metric for the outlier check: the latest CURRENT
# (is_superseded=FALSE) row for the logical fact at an observation STRICTLY EARLIER than the period
# being QA'd. Consolidated only (dim_signature=''). One row per metric (the most recent prior period).
# DISTINCT ON keyed to metric, ordered by observation_ts DESC so the first row per metric is the latest
# prior. Mirrors the bars/fundamentals as-of read shape.
_SELECT_PRIOR_VALUE = """
SELECT DISTINCT ON (metric) metric, value
FROM fundamentals
WHERE instrument_id = $1 AND metric = ANY($2::text[]) AND dim_signature = ''
  AND observation_ts < $3 AND is_superseded = FALSE AND value IS NOT NULL
ORDER BY metric, observation_ts DESC
"""

# Append one QA finding to the review queue. Identical shape to the writer's `_INSERT_QUARANTINE`
# (instrument_id, filing_id, reason, payload::jsonb) — the QA engine and the writer write the same table
# the same way; only the `reason` vocabulary differs.
_INSERT_QUARANTINE = """
INSERT INTO fundamentals_quarantine (instrument_id, filing_id, reason, payload)
VALUES ($1, $2, $3, $4::jsonb)
"""


def _consolidated_periods(facts: Iterable[InterpretedFact]) -> list[int]:
    """The distinct consolidated observation periods present in a filing (used to bound the prior-value
    lookup to 'strictly before the earliest period this filing reports')."""
    return sorted({f.period_end for f in facts if not f.is_segment and not f.dim_signature})


def _finding_payload(finding: QuarantineFinding) -> str:
    """A `QuarantineFinding` → the quarantine `payload` JSON. Carries the metric + observation_ts
    alongside the check's own detail so the report surface can group/filter without re-deriving."""
    return json.dumps(
        {
            "metric": finding.metric,
            "observation_ts": finding.observation_ts,
            **finding.detail,
        },
        sort_keys=True,
    )


class QaEngine:
    """Runs the QA checks over a filing's normalized facts and appends failures to
    `fundamentals_quarantine`. Inject an asyncpg.Pool."""

    def __init__(self, pool) -> None:
        self._pool = pool

    async def qa_filing(
        self,
        facts: StageResult | Iterable[InterpretedFact],
        *,
        instrument_id: int,
        sector: str,
        filing_id: Optional[int] = None,
        required: tuple[str, ...] = checks.REQUIRED_METRICS,
    ) -> QaStats:
        """QA one filing's normalized facts + quarantine the failures.

        Accepts either a `StageResult` (convenience — the cron has one in hand from staging) or a bare
        iterable of `InterpretedFact`s. `sector` is the SIC→template choice (Task 7's
        `sectors.template_for_sic`) and GATES the identity check (General-only). `instrument_id` is the
        resolved id (the cron resolves CIK→instrument_id via the security master); a None id is a
        programming error and raises (never a fabricated 0, mirroring the writer). Idempotent only in the
        sense the canonical write is — quarantine is an APPEND review queue (0009), so re-QA'ing a filing
        MAY append duplicate findings; Task 8 owns the queue's lifecycle, and the canonical PIT surface is
        untouched by quarantine churn."""
        if instrument_id is None:
            raise ValueError("QaEngine.qa_filing: instrument_id is required "
                             "(resolve CIK→instrument_id before QA; never a fabricated id)")

        fact_list = list(facts.facts if isinstance(facts, StageResult) else facts)
        consolidated = [f for f in fact_list if not f.is_segment and not f.dim_signature]

        prior_values = await self._fetch_prior_values(fact_list, instrument_id=instrument_id)
        findings = checks.run_checks(
            fact_list, sector=sector, prior_values=prior_values, required=required
        )

        quarantined, by_reason = await self._quarantine(
            findings, instrument_id=instrument_id, filing_id=filing_id
        )
        return QaStats(checked=len(consolidated), quarantined=quarantined, by_reason=by_reason)

    async def _fetch_prior_values(
        self, facts: list[InterpretedFact], *, instrument_id: int
    ) -> dict[tuple[str, str], float]:
        """The latest current consolidated value per metric at an observation BEFORE this filing's
        earliest reported period — the outlier check's prior baseline. Returns `{(metric, ''): value}`
        (consolidated dim only). Empty when the filing reports nothing consolidated or the instrument has
        no earlier history (a first-ever filing simply has no outlier baseline)."""
        periods = _consolidated_periods(facts)
        if not periods:
            return {}
        metrics = sorted({f.metric for f in facts if not f.is_segment and not f.dim_signature})
        if not metrics:
            return {}
        earliest = periods[0]
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(_SELECT_PRIOR_VALUE, instrument_id, metrics, earliest)
        return {(r["metric"], ""): float(r["value"]) for r in rows if r["value"] is not None}

    async def _quarantine(
        self,
        findings: tuple[QuarantineFinding, ...],
        *,
        instrument_id: int,
        filing_id: Optional[int],
    ) -> tuple[int, dict[str, int]]:
        """Append each finding to `fundamentals_quarantine`. Best-effort isolation per row: a failed
        insert logs and continues (a QA finding is a signal, never a reason to abort — the canonical
        write already succeeded). Returns (count_written, by_reason_counts)."""
        if not findings:
            return 0, {}
        written = 0
        by_reason: dict[str, int] = {}
        async with self._pool.acquire() as conn:
            for finding in findings:
                try:
                    await conn.execute(
                        _INSERT_QUARANTINE,
                        instrument_id, filing_id, finding.reason, _finding_payload(finding),
                    )
                    written += 1
                    by_reason[finding.reason] = by_reason.get(finding.reason, 0) + 1
                except Exception as exc:  # noqa: BLE001 — quarantine is best-effort; never block QA
                    log.error(
                        "[qa] quarantine insert failed for instrument=%s reason=%s metric=%s: %s",
                        instrument_id, finding.reason, finding.metric, exc,
                    )
        return written, by_reason
