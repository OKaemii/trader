"""Content hash for the raw zone — the idempotency gate over a single `fundamentals_raw_facts` row.

The raw zone is append-only + full-preservation: a re-ingest (the bulk seed re-run after the nightly
incremental, or two overlapping companyconcept pulls) MUST be a clean no-op for an identical fact, not
a duplicate-key error and not a silent overwrite. The PK already enforces uniqueness on the fact
*identity* `(filing_id, raw_tag, context_id, period_type, period_end, knowledge_ts, dim_signature)`;
this hash adds the value-level gate so the writer can `ON CONFLICT DO NOTHING` and additionally detect
the (anomalous) case where the same identity arrives with a *different* value — a sign of an upstream
restatement that kept the same accession (which belongs in the canonical supersede flow, Task 7, not a
raw overwrite).

This mirrors the bars/`fundamentals` `content_hash` discipline (`packages/shared-bars/.../content-hash.ts`
`hashBarContent`; 0009's header note for the canonical table). The canonical `fundamentals` hash is
SHA-1 over `(metric, observation_ts, value, unit, currency, dim_signature)` — a *normalized* tuple. The
raw zone hashes the *raw* tuple instead (no metric yet — that's the normalize step), over the full
preserved identity + value so two genuinely-distinct raw facts never collide on the hash and an
identical re-ingest always matches. Stable field order + a NUL separator (a value can't contain it) so
the digest is deterministic across runs/processes.
"""
from __future__ import annotations

import hashlib
from typing import Optional


def _norm(value: object) -> str:
    """A field → its canonical string for hashing. None → '' (the same sentinel the '' columns use);
    a float is repr'd so 1.0 and 1 hash identically to the stored DOUBLE PRECISION value (1.0)."""
    if value is None:
        return ""
    if isinstance(value, float):
        return repr(float(value))
    return str(value)


def hash_raw_fact(
    *,
    filing_id: int,
    raw_tag: str,
    context_id: str,
    period_type: str,
    period_start: Optional[int],
    period_end: int,
    knowledge_ts: int,
    value: Optional[float],
    unit: Optional[str],
    currency: Optional[str],
    dim_signature: str,
) -> str:
    """SHA-1 over the full raw fact identity + value. The PK columns plus `period_start`/`value`/`unit`/
    `currency` — everything that distinguishes one preserved fact from another — so an identical
    re-ingest produces the same digest (a no-op) and any value drift on the same identity is visible."""
    parts = (
        _norm(filing_id),
        _norm(raw_tag),
        _norm(context_id),
        _norm(period_type),
        _norm(period_start),
        _norm(period_end),
        _norm(knowledge_ts),
        _norm(value),
        _norm(unit),
        _norm(currency),
        _norm(dim_signature),
    )
    return hashlib.sha1("\x00".join(parts).encode("utf-8")).hexdigest()
