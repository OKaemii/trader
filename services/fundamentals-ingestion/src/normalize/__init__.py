"""normalize — sector-template selection + the bi-temporal `fundamentals` writer (epic Task 7).

Selects a sector template (General / Bank / Insurance / REIT / Utility), de-dups restatements, and
writes canonical long facts to the `fundamentals` hypertable with supersede-in-transaction (the
persist-bars.ts pattern): the prior `is_superseded=FALSE` row flips inside the same txn as the new
insert, so the partial-unique index holds exactly one current row per logical fact. content_hash is
SHA-1 over (metric, observation_ts, value, unit, currency, dim_signature) per the schema card.
"""
