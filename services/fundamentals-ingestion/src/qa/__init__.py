"""qa — sector-aware data-quality checks + quarantine (epic Task 8).

Runs identity checks (`Assets ≈ Liabilities + Equity` for the General template only; banks / insurers
/ REITs get their own), outlier detection (e.g. Revenue +5000%, Assets −99%), and missing-data
checks. Failures route to `fundamentals_quarantine` (not the canonical `fundamentals` table) and are
surfaced through an admin QA-report endpoint rather than silently dropped or silently accepted.

PUBLIC SURFACE (the cron, Task 9, imports the engine; main.py imports the report):
  * `checks.run_checks(facts, *, sector, prior_values, required)` — the PURE check layer (no I/O).
    Sector-aware identity (General-only), period-over-period outliers, missing-required-data → a tuple
    of `QuarantineFinding`s. Reason constants: `REASON_IDENTITY_BREAK` / `REASON_OUTLIER` /
    `REASON_MISSING_DATA` (the 0009 vocabulary the writer's `value_disagreement` joins).
  * `QaEngine(pool).qa_filing(facts, *, instrument_id, sector, filing_id)` — runs the checks (fetching
    the outlier baseline from the warehouse) and APPENDS failures to `fundamentals_quarantine`. Runs
    alongside the Task-7 canonical write; never blocks the good rows.
  * `report.quarantine_summary(pool, *, since_ms, sample_limit)` — the admin report: counts by reason +
    by sector (LEFT JOIN to security_master) + a recent sample. Served at
    `/admin/api/fundamentals-ingest/quarantine` (reuses the Task-3 ingress prefix — no new ingress).
"""
from . import checks, report
from .checks import (
    REASON_IDENTITY_BREAK,
    REASON_MISSING_DATA,
    REASON_OUTLIER,
    QuarantineFinding,
    run_checks,
)
from .engine import QaEngine, QaStats

__all__ = [
    "checks",
    "report",
    "run_checks",
    "QuarantineFinding",
    "QaEngine",
    "QaStats",
    "REASON_IDENTITY_BREAK",
    "REASON_OUTLIER",
    "REASON_MISSING_DATA",
]
