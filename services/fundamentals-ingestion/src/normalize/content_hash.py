"""Content hash for the CANONICAL `fundamentals` table — the supersede gate (epic Task 7).

Distinct from the raw-zone hash (`raw_store/content_hash.py`, which hashes the full preserved raw
identity + value). The canonical hash is the 0009_fundamentals.sql convention — SHA-1 over the
NORMALIZED tuple ``(metric, observation_ts, value, unit, currency, dim_signature)`` — and drives the
supersede-in-transaction decision exactly as `hashBarContent` drives `persist-bars.ts`:

  * Identical hash for the latest unsuperseded row ⇒ a re-ingest is a NO-OP (no insert, no supersede,
    no revisions-log row, no transaction) — the bars idempotency contract.
  * A different hash for the same logical fact ``(instrument_id, metric, observation_ts,
    dim_signature)`` ⇒ a genuine revision/restatement: flip the prior row's `is_superseded` and insert
    the new revision, in ONE transaction.

WHY this exact tuple (and NOT instrument_id / knowledge_ts / fiscal labels / source / accession):
  * `instrument_id`, `metric`, `observation_ts`, `dim_signature` are the LOGICAL-FACT key — the
    supersede decision is *scoped* to one such key, so they identify WHICH row to compare against, not
    whether its CONTENT changed. (Putting them in the hash would be redundant — every comparison is
    already within a fixed key.) `observation_ts` IS in the tuple because the schema header (0009)
    lists it; it is constant within a key, so it only makes two facts at different periods hash
    differently — harmless and matches the documented convention.
  * `knowledge_ts` is the bi-temporal DISCRIMINATOR, not content — a restatement is precisely "same
    content key, new knowledge_ts" or "changed value at a new knowledge_ts"; hashing knowledge_ts
    would make every print look like a change and defeat the idempotency no-op.
  * `fiscal_year`/`fiscal_period`, `source`, `accession_number`, `raw_tag` are PROVENANCE/labelling —
    a corrected accession or a re-derived fiscal label with the SAME value is not a value revision and
    must stay a no-op. They ride on the row but not in the hash.
  * `value`/`unit`/`currency` ARE the content — a restated value (10-K/A), a units-of-presentation
    change, or a currency correction is a genuine supersede. These are what the hash must be sensitive
    to.

Stable field order + a NUL separator (a value can't contain it) so the digest is deterministic across
runs/processes; floats are `repr`'d so 1.0 and an int 1 hash identically to the stored DOUBLE
PRECISION (matching the raw-zone `_norm`).
"""
from __future__ import annotations

import hashlib
from typing import Optional


def _norm(value: object) -> str:
    """A field → its canonical string for hashing. None → '' (the '' sentinel the columns use); a
    float is repr'd so 1.0 and 1 hash identically to the stored DOUBLE PRECISION value (1.0). Mirrors
    `raw_store.content_hash._norm` so the two hash families share one normalization discipline."""
    if value is None:
        return ""
    if isinstance(value, float):
        return repr(float(value))
    return str(value)


def hash_fundamental(
    *,
    metric: str,
    observation_ts: int,
    value: Optional[float],
    unit: Optional[str],
    currency: Optional[str],
    dim_signature: str,
) -> str:
    """SHA-1 over the canonical `fundamentals` content tuple (0009 convention):
    ``(metric, observation_ts, value, unit, currency, dim_signature)``. Two canonical facts within the
    same logical key produce the same digest iff their VALUE-bearing content matches — so an identical
    re-ingest is a no-op and a restated value supersedes."""
    parts = (
        _norm(metric),
        _norm(observation_ts),
        _norm(value),
        _norm(unit),
        _norm(currency),
        _norm(dim_signature),
    )
    return hashlib.sha1("\x00".join(parts).encode("utf-8")).hexdigest()
