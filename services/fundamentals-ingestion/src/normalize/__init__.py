"""normalize — sector-template selection + the bi-temporal `fundamentals` writer (epic Task 7).

The PIT-contract core. Selects a sector template (General / Bank / Insurance / REIT / Utility) by SIC
(so the Task-6 staging applies bank/insurer/REIT/utility tag overrides), de-dups restatements, and
writes canonical long facts to `fundamentals` + `fundamentals_revisions_log` with
supersede-in-transaction (the `persist-bars.ts` pattern): the prior `is_superseded=FALSE` row flips
inside the SAME txn as the new insert, so the partial-unique index holds exactly one current row per
logical fact. `content_hash` is SHA-1 over `(metric, observation_ts, value, unit, currency,
dim_signature)` per the schema card (distinct from the raw-zone hash). `knowledge_ts` is DERIVED — the
next NYSE session open after the filing's raw `accepted_ts` (after-hours accept → next session). A
10-K/A restatement is a NEW row + supersede, never an overwrite; the original stays readable at its
original as-of. Value-agreement conflicts from staging are handed off to `fundamentals_quarantine`
(the QA engine that populates/reports the rest is Task 8).

Public surface (imported by the cron/backfill — epic Task 9 — and the tests):
  sectors       — `template_for_sic` (SIC → general|bank|insurance|reit|utility) + the TEMPLATE_* names.
  calendar      — `next_session_open_ms` (the availability hop; rule-based NYSE holidays, all years).
  content_hash  — `hash_fundamental` (the canonical supersede hash).
  writer        — `FundamentalsWriter` (supersede-in-txn) + `FundamentalRow` + `build_fundamental_row`
                  + `WriteStats` + the `SOURCE_PIT_EDGAR` stamp.

The sector classifier + the calendar helper are PURE; `FundamentalsWriter` takes an injected
asyncpg.Pool and opens no socket on import. The tests run against fixtures + the in-memory Timescale
double — no network, no DB.
"""
from __future__ import annotations

from .calendar import next_session_open_ms
from .content_hash import hash_fundamental
from .sectors import (
    TEMPLATE_BANK,
    TEMPLATE_GENERAL,
    TEMPLATE_INSURANCE,
    TEMPLATE_REIT,
    TEMPLATE_UTILITY,
    TEMPLATES,
    template_for_sic,
)
from .writer import (
    SOURCE_PIT_EDGAR,
    FundamentalRow,
    FundamentalsWriter,
    WriteStats,
    build_fundamental_row,
)

__all__ = [
    # sectors
    "template_for_sic",
    "TEMPLATES",
    "TEMPLATE_GENERAL",
    "TEMPLATE_BANK",
    "TEMPLATE_INSURANCE",
    "TEMPLATE_REIT",
    "TEMPLATE_UTILITY",
    # calendar
    "next_session_open_ms",
    # content hash
    "hash_fundamental",
    # writer
    "FundamentalsWriter",
    "FundamentalRow",
    "build_fundamental_row",
    "WriteStats",
    "SOURCE_PIT_EDGAR",
]
