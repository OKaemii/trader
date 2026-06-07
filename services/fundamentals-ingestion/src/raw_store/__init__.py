"""raw_store — the append-only raw zone (epic Task 5).

Writes every parsed fact to `fundamentals_raw_facts` (full us-gaap:* + dei:* preservation) before any
interpretation, so the canonical normalization is always re-derivable from source. Honours the
dependency-card contract: the raw PK is
`(filing_id, raw_tag, context_id, period_type, period_end, knowledge_ts, dim_signature)` with
`context_id` NOT NULL DEFAULT '' — the writer must emit `context_id` (default '' when XBRL gives no
context), never NULL, or two distinct facts collide on a hard duplicate-key error.
"""
