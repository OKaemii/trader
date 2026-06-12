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
# exactly these columns (in this order) and the DuckDB read engine reads them by name. Nullability is
# part of the contract and declared EXPLICITLY (not left to pyarrow's nullable=True default): `start`
# and `accepted_ts` are the only nullable columns by intent (instant facts have no period start; the
# bulk-zip path has no acceptance time), while `knowledge_ts` is `nullable=False` because it is the PIT
# read axis — the read filter `knowledge_ts <= :as_of` silently DROPS nulls, so a null read-axis value
# is a latent look-ahead-adjacent hole; the non-null flag makes a writer that ever emits one fail loudly
# at write time rather than vanish the row from PIT reads (`derive_knowledge_ts` is total — it never
# returns None — so a correct writer is unaffected). Every other column is non-null by intent too.
SCHEMA = pa.schema(
    [
        pa.field("cik", pa.int32(), nullable=False),
        pa.field("taxonomy", pa.string(), nullable=False),   # us-gaap | ifrs-full | dei | srt
        pa.field("concept", pa.string(), nullable=False),    # e.g. Revenues
        pa.field("unit", pa.string(), nullable=False),       # USD | shares | USD/shares
        pa.field("start", pa.date32(), nullable=True),       # null for instant (balance-sheet) facts
        pa.field("end", pa.date32(), nullable=False),        # period_end / instant date
        pa.field("value", pa.float64(), nullable=False),
        pa.field("fy", pa.int16(), nullable=False),
        pa.field("fp", pa.string(), nullable=False),         # FY | Q1..Q4 (as tagged by the filer)
        pa.field("form", pa.string(), nullable=False),       # 10-K | 10-Q | 10-K/A | 20-F | ...
        pa.field("accession", pa.string(), nullable=False),  # full lineage back to the raw filing
        pa.field("filed", pa.date32(), nullable=False),      # SEC filing date (coarse, day-granularity)
        pa.field("accepted_ts", pa.int64(), nullable=True),  # EDGAR acceptanceDateTime, UTC ms — bulk path has none
        pa.field("knowledge_ts", pa.int64(), nullable=False),  # DERIVED next-NYSE-session-open availability, UTC ms — the read axis
        pa.field("frame", pa.string(), nullable=True),       # the SEC `frame` tag — absent on many facts
    ]
)
