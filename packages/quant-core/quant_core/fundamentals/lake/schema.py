"""Per-CIK fact-lake Parquet schema — the on-disk contract for the PIT fundamentals lake.

One zstd-Parquet file per CIK (`facts/cik=<cik:010d>.parquet`), written atomically (tmpfile +
`os.replace`) so the unit of refresh equals the unit of storage: a refresh is a single atomic file
replace, idempotent by construction, and a reader mid-refresh sees the old file until the swap (no
torn read). Every row keeps BOTH time axes plus the derived availability:

  * `start` / `end`   — the fiscal period the value describes (`start` NULL for instant/balance-sheet
                        facts; `end` is the period_end / instant).
  * `filed`           — the SEC filing DATE (the prototype's coarse PIT axis; day-granularity only).
  * `accepted_ts`     — the EDGAR `acceptanceDateTime` (genuine UTC ms) per accession, NULLABLE: the
                        30-min sweep carries it, the bulk-zip bootstrap does not (note 3).
  * `knowledge_ts`    — DERIVED, NON-null: the next NYSE session open after `accepted_ts` (or, on the
                        bulk path, after `filed`'s close) — `derive_knowledge_ts` in `lake.calendar`.
                        THIS is the real read axis: the PIT read filter is `knowledge_ts <= :as_of`.

Restatements/amendments (a 10-K/A) are simply more rows with a later `knowledge_ts` — nothing is ever
overwritten, and an as-of read picks the latest row known at or before the cutoff (`QUALIFY
row_number() OVER (… ORDER BY knowledge_ts DESC, accession DESC)`), so there is no `is_superseded` flag
and no transaction log. This extends the prototype's base schema with the two availability columns
(`accepted_ts`, `knowledge_ts`); the read engine (later tasks) targets the single per-CIK file on the
hot path (no glob), so a per-name read is O(one file) — no OOM, no chunk fan.

pyarrow is the `quant-core[lake]` extra (the live strategy host installs only `[http]`); a caller that
needs only the `knowledge_ts` derivation imports `lake.calendar` instead, which is pure stdlib.
"""
from __future__ import annotations

import pyarrow as pa

# The per-CIK fact-row schema. Column ORDER and TYPES are the on-disk contract — the harvester writes
# exactly these columns (in this order) and the DuckDB read engine reads them by name. `start`/`accepted_ts`
# are the only nullable columns by intent (instant facts have no period start; the bulk path has no
# acceptance time); `knowledge_ts` is NON-null because the read axis must always resolve.
SCHEMA = pa.schema(
    [
        ("cik", pa.int32()),
        ("taxonomy", pa.string()),    # us-gaap | ifrs-full | dei | srt
        ("concept", pa.string()),     # e.g. Revenues
        ("unit", pa.string()),        # USD | shares | USD/shares
        ("start", pa.date32()),       # null for instant (balance-sheet) facts
        ("end", pa.date32()),         # period_end / instant date
        ("value", pa.float64()),
        ("fy", pa.int16()),
        ("fp", pa.string()),          # FY | Q1..Q4 (as tagged by the filer)
        ("form", pa.string()),        # 10-K | 10-Q | 10-K/A | 20-F | ...
        ("accession", pa.string()),   # full lineage back to the raw filing
        ("filed", pa.date32()),       # SEC filing date (the coarse, day-granularity PIT axis)
        ("accepted_ts", pa.int64()),  # EDGAR acceptanceDateTime, UTC ms — NULLABLE (bulk path has none)
        ("knowledge_ts", pa.int64()),  # DERIVED next-NYSE-session-open availability, UTC ms — NON-null
        ("frame", pa.string()),
    ]
)
