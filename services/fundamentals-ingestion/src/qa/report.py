"""QA report surface — summarize `fundamentals_quarantine` for the admin endpoint (epic Task 8).

The read side of Task 8: aggregates the append-only quarantine queue into the operator-facing summary
the `/admin/api/fundamentals-ingest/quarantine` endpoint serves — counts by REASON and by SECTOR, plus
a recent-events sample. Pure SQL aggregation over the warehouse (no business logic), so the FastAPI
handler in `main.py` stays a thin pass-through.

WHY this is a separate module from the engine: the engine WRITES (one filing at a time, in the ingest
path); the report READS (operator review, on demand). Splitting them keeps the engine importable in the
cron worker without the report SQL and lets the report be tested against the same FakeTimescale without
constructing an engine.

GROUPING AXES:
  * by REASON — always available (the quarantine row's own column): value_disagreement (Task-7 writer),
    identity_break / outlier / missing_data (this engine), plus any future reason (pdf_only for UK).
  * by SECTOR — the filer's sector. The quarantine row has no sector column (a filing can fail before
    instrument resolution), so sector is resolved via a LEFT JOIN to `security_master.companies` through
    `instruments` on `instrument_id`. A row with no resolvable sector (null instrument_id, or a company
    with no sector classified) groups under the '(unknown)' bucket — surfaced, never dropped. This makes
    the financials-are-the-quarantine-hotspot pattern (the plan's edge case) directly observable.

The aggregation is bounded by an optional `since`/`limit` so the endpoint never scans the whole
hypertable; defaults cover a sensible recent window.
"""
from __future__ import annotations

import json
from typing import Any, Optional

# Sentinel sector bucket for a quarantine row whose instrument/sector can't be resolved (a filing that
# failed before instrument resolution, or a company with no sector classified). Surfaced explicitly so a
# count is never silently lost.
SECTOR_UNKNOWN = "(unknown)"

# Default recent-events sample size for the report (bounded so the endpoint stays cheap). The summary
# counts are unbounded over the `since` window; only the row sample is capped.
DEFAULT_SAMPLE_LIMIT = 50


# ── SQL ────────────────────────────────────────────────────────────────────────────
# Total + by-reason counts over the window. $1 is the lower-bound `occurred_at` as a timestamptz (bound
# natively from a Python datetime by `_since_param`), or NULL for an unbounded window. The
# `$1::timestamptz IS NULL OR occurred_at >= $1` predicate is a no-op when $1 is NULL (NULL IS NULL is
# TRUE), so "all time" needs no separate query.
_COUNT_BY_REASON = """
SELECT reason, COUNT(*) AS n
FROM fundamentals_quarantine
WHERE ($1::timestamptz IS NULL OR occurred_at >= $1)
GROUP BY reason
ORDER BY n DESC, reason
"""

# By-sector counts: LEFT JOIN quarantine → instruments → companies on instrument_id, grouping on the
# company's sector (NULL → the unknown bucket, coalesced in Python). LEFT JOINs so a row with an
# unresolved instrument still counts.
_COUNT_BY_SECTOR = """
SELECT c.sector AS sector, COUNT(*) AS n
FROM fundamentals_quarantine q
LEFT JOIN security_master.instruments i ON i.instrument_id = q.instrument_id
LEFT JOIN security_master.companies   c ON c.company_id    = i.company_id
WHERE ($1::timestamptz IS NULL OR q.occurred_at >= $1)
GROUP BY c.sector
ORDER BY n DESC
"""

# A recent sample of quarantine rows for the operator to eyeball (newest first), bounded by $2.
_RECENT_SAMPLE = """
SELECT event_id, occurred_at, instrument_id, filing_id, reason, payload
FROM fundamentals_quarantine
WHERE ($1::timestamptz IS NULL OR occurred_at >= $1)
ORDER BY occurred_at DESC, event_id DESC
LIMIT $2
"""


def _coerce_payload(payload: Any) -> Any:
    """asyncpg returns a JSONB column as a str (no codec registered) — decode it so the endpoint emits
    real JSON, not a JSON-string-inside-JSON. A dict (already decoded, or the FakeTimescale) passes
    through; a non-JSON str is returned as-is (never raises into the handler)."""
    if isinstance(payload, (dict, list)):
        return payload
    if isinstance(payload, str):
        try:
            return json.loads(payload)
        except (ValueError, TypeError):
            return payload
    return payload


async def quarantine_summary(
    pool,
    *,
    since_ms: Optional[int] = None,
    sample_limit: int = DEFAULT_SAMPLE_LIMIT,
) -> dict:
    """Aggregate `fundamentals_quarantine` into the admin report.

    `since_ms` bounds the window (UTC ms; None = all time). Returns:
      {
        "total": <int>,
        "by_reason": { "<reason>": <int>, … },     # value_disagreement / identity_break / outlier / …
        "by_sector": { "<sector>|(unknown)": <int>, … },
        "recent":    [ { event_id, occurred_at, instrument_id, filing_id, reason, payload }, … ],
        "since_ms":  <int|null>,
      }
    Pure pass-through over the SQL above — no business logic. The handler serialises this as-is."""
    since_param = _since_param(since_ms)
    limit = max(1, int(sample_limit))

    async with pool.acquire() as conn:
        reason_rows = await conn.fetch(_COUNT_BY_REASON, since_param)
        sector_rows = await conn.fetch(_COUNT_BY_SECTOR, since_param)
        sample_rows = await conn.fetch(_RECENT_SAMPLE, since_param, limit)

    by_reason = {r["reason"]: int(r["n"]) for r in reason_rows}
    by_sector: dict[str, int] = {}
    for r in sector_rows:
        bucket = r["sector"] if r["sector"] else SECTOR_UNKNOWN
        by_sector[bucket] = by_sector.get(bucket, 0) + int(r["n"])

    recent = [
        {
            "event_id": r["event_id"],
            "occurred_at": _iso(r["occurred_at"]),
            "instrument_id": r["instrument_id"],
            "filing_id": r["filing_id"],
            "reason": r["reason"],
            "payload": _coerce_payload(r["payload"]),
        }
        for r in sample_rows
    ]

    return {
        "total": sum(by_reason.values()),
        "by_reason": by_reason,
        "by_sector": by_sector,
        "recent": recent,
        "since_ms": since_ms,
    }


def _since_param(since_ms: Optional[int]):
    """A UTC-ms bound → the timestamptz the SQL compares against (passed as a datetime so asyncpg binds
    it natively), or None for an unbounded window."""
    if since_ms is None:
        return None
    from datetime import datetime, timezone

    return datetime.fromtimestamp(since_ms / 1000, tz=timezone.utc)


def _iso(value: Any) -> Any:
    """A timestamptz (datetime) → ISO-8601 string for the JSON response; pass through anything else
    (the FakeTimescale may store a raw value)."""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value
